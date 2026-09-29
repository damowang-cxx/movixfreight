import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ShipmentDispatchJobStatus, ShipmentStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'net';
import { PrismaService } from '../database/prisma.service';
import { ShipmentOperationsService } from '../orders/shipment-operations.service';

type DispatchPayload = { orderId: string };

@Injectable()
export class ShipmentDispatchQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShipmentDispatchQueueService.name);
  private queue!: Queue<DispatchPayload>;
  private worker!: Worker<DispatchPayload>;
  private retryTimer?: NodeJS.Timeout;
  private redisUnavailableLogged = false;
  private readonly workerEnabled: boolean;

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, private readonly operations: ShipmentOperationsService) {
    this.workerEnabled = this.config.get<string>('DISPATCH_WORKER_ENABLED') !== 'false';
  }

  async onModuleInit() {
    await this.connectIfAvailable();
    this.retryTimer = setInterval(() => { void this.connectIfAvailable(); }, 10_000);
  }

  async onModuleDestroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    await this.worker?.close();
    await this.queue?.close();
  }

  async enqueue(orderId: string) {
    await this.connectIfAvailable();
    if (!this.queue) {
      await this.markQueueUnavailable(orderId);
      return false;
    }
    try {
      await this.queue.add('dispatch-shipment', { orderId }, { jobId: orderId, attempts: 1, removeOnComplete: true, removeOnFail: true });
      await this.prisma.shipmentDispatchJob.updateMany({ where: { orderId, status: ShipmentDispatchJobStatus.PENDING }, data: { stage: 'QUEUED', reasonCode: 'QUEUED', publicMessage: '订单已受理，正在等待面单生成', errorMessage: null } });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知队列错误';
      if (!message.includes('already exists')) {
        this.logger.warn(`面单任务将在 Redis 恢复后重新投递：${message}`);
        await this.markQueueUnavailable(orderId, message);
        return false;
      }
      return true;
    }
  }

  private async process(orderId: string) {
    const claim = await this.prisma.shipmentDispatchJob.updateMany({ where: { orderId, status: ShipmentDispatchJobStatus.PENDING, order: { shipmentStatus: ShipmentStatus.SUBMITTED } }, data: { status: ShipmentDispatchJobStatus.PROCESSING, stage: 'VALIDATING', reasonCode: 'VALIDATING', publicMessage: '正在校验订单信息', attempts: { increment: 1 }, startedAt: new Date(), claimedAt: new Date(), errorMessage: null } });
    if (claim.count !== 1) return;
    try {
      await this.operations.create(orderId, async (stage) => {
        await this.prisma.shipmentDispatchJob.updateMany({ where: { orderId, status: ShipmentDispatchJobStatus.PROCESSING }, data: { stage, reasonCode: stage, publicMessage: stage === 'VALIDATING' ? '正在校验订单信息' : '正在向供应商生成面单' } });
      });
      await this.prisma.shipmentDispatchJob.update({ where: { orderId }, data: { status: ShipmentDispatchJobStatus.COMPLETED, stage: 'READY', reasonCode: 'LABEL_READY', publicMessage: '面单已生成，可预览或下载 PDF', errorMessage: null, completedAt: new Date() } });
    } catch (error) {
      const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { shipmentStatus: true } });
      const status = order?.shipmentStatus === ShipmentStatus.UNKNOWN ? ShipmentDispatchJobStatus.UNKNOWN : ShipmentDispatchJobStatus.FAILED;
      if (order?.shipmentStatus === ShipmentStatus.SUBMITTED) {
        await this.prisma.order.updateMany({ where: { id: orderId, shipmentStatus: ShipmentStatus.SUBMITTED }, data: { shipmentStatus: status === ShipmentDispatchJobStatus.UNKNOWN ? ShipmentStatus.UNKNOWN : ShipmentStatus.FAILED } });
      }
      const detail = this.errorDetail(error);
      const stage = (await this.prisma.shipmentDispatchJob.findUnique({ where: { orderId }, select: { stage: true } }))?.stage;
      const validationFailed = stage === 'VALIDATING';
      const safeDetail = this.safeSupplierError(error);
      const pdfFailure = order?.shipmentStatus === ShipmentStatus.GENERATED;
      const publicMessage = pdfFailure ? '运单已生成，PDF 处理失败；可再次预览/下载仅重做本地转换' : status === ShipmentDispatchJobStatus.UNKNOWN
        ? '供应商处理结果未知，请勿重复下单并联系管理员核查'
        : validationFailed
          ? `供应商校验未通过${safeDetail ? `：${safeDetail}` : '，请检查收件信息、申报信息或服务配置'}`
          : `供应商拒绝生成面单${safeDetail ? `：${safeDetail}` : '，请检查订单信息'}`;
      await this.prisma.shipmentDispatchJob.update({ where: { orderId }, data: { status, stage: status === ShipmentDispatchJobStatus.UNKNOWN ? 'UNKNOWN' : 'FAILED', reasonCode: pdfFailure ? 'LABEL_PROCESSING_FAILED' : status === ShipmentDispatchJobStatus.UNKNOWN ? 'SUPPLIER_RESULT_UNKNOWN' : validationFailed ? 'VALIDATION_REJECTED' : 'SUPPLIER_REJECTED', publicMessage, errorMessage: detail, completedAt: new Date() } });
    }
  }

  private redisConnection() {
    const value = new URL(this.config.get<string>('REDIS_URL') ?? 'redis://127.0.0.1:6379');
    return { host: value.hostname, port: Number(value.port || 6379), ...(value.password ? { password: value.password } : {}) };
  }

  private async connectIfAvailable() {
    if (this.queue) { if (this.workerEnabled) await this.enqueuePending(); return; }
    if (!await this.redisAvailable()) {
      if (!this.redisUnavailableLogged) {
        this.redisUnavailableLogged = true;
        this.logger.warn('Redis 未启动，面单任务将保持待处理；Redis 恢复后会自动投递');
      }
      return;
    }
    const connection = this.redisConnection();
    this.queue = new Queue<DispatchPayload>('open-api-shipment-dispatch', { connection });
    if (this.workerEnabled) {
      this.worker = new Worker<DispatchPayload>('open-api-shipment-dispatch', async (job) => this.process(job.data.orderId), { connection, concurrency: Number(this.config.get<string>('DISPATCH_WORKER_CONCURRENCY') ?? 1) });
      this.worker.on('error', (error) => this.logger.error(`面单任务队列错误：${error.message || String(error)}`));
    }
    this.redisUnavailableLogged = false;
    await this.enqueuePending();
    this.logger.log(this.workerEnabled ? '面单任务队列与 Worker 已连接 Redis' : '面单任务队列已连接 Redis（当前实例不执行 Worker）');
  }

  private async enqueuePending() {
    if (!this.queue) return;
    const pending = await this.prisma.shipmentDispatchJob.findMany({ where: { status: ShipmentDispatchJobStatus.PENDING }, select: { orderId: true } });
    await Promise.all(pending.map(async (job) => {
      try { await this.queue.add('dispatch-shipment', { orderId: job.orderId }, { jobId: job.orderId, attempts: 1, removeOnComplete: true, removeOnFail: true }); }
      catch (error) { const message = error instanceof Error ? error.message : ''; if (!message.includes('already exists')) this.logger.warn(`待处理面单任务投递失败：${message || '未知错误'}`); }
    }));
  }

  private async markQueueUnavailable(orderId: string, technicalDetail?: string) {
    await this.prisma.shipmentDispatchJob.updateMany({ where: { orderId, status: ShipmentDispatchJobStatus.PENDING }, data: { stage: 'QUEUED', reasonCode: 'QUEUE_UNAVAILABLE', publicMessage: '面单任务正在等待队列服务恢复', errorMessage: technicalDetail ?? 'Redis 队列当前不可用' } });
  }

  private errorDetail(error: unknown) {
    if (error instanceof Error && 'getResponse' in error && typeof (error as any).getResponse === 'function') {
      const response = (error as any).getResponse();
      try { return JSON.stringify(response).slice(0, 2_000); } catch { return error.message; }
    }
    return error instanceof Error ? error.message : '未知供应商错误';
  }

  private safeSupplierError(error: unknown) {
    const response = error instanceof Error && 'getResponse' in error && typeof (error as any).getResponse === 'function' ? (error as any).getResponse() : undefined;
    const candidates = response && typeof response === 'object' ? [(response as any).errors, (response as any).message] : [response];
    const values: string[] = [];
    const visit = (value: unknown) => {
      if (values.length >= 3 || value === null || value === undefined) return;
      if (typeof value === 'string') { const text = value.replace(/https?:\/\/\S+/gi, '').trim(); if (text) values.push(text.slice(0, 180)); return; }
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (typeof value === 'object') {
        const item = value as Record<string, unknown>;
        visit(item.message ?? item.localizedMessage ?? item.description ?? item.code);
      }
    };
    candidates.forEach(visit);
    return [...new Set(values)].join('；');
  }

  private async redisAvailable() {
    const connection = this.redisConnection();
    return new Promise<boolean>((resolve) => {
      const socket = createConnection(connection);
      let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
      socket.setTimeout(800);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
  }
}
