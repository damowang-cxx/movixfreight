import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ShipmentDispatchJobStatus, ShipmentStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'net';
import { PrismaService } from '../database/prisma.service';
import { FedexValidationService } from '../orders/fedex-validation.service';

type DispatchPayload = { orderId: string };

@Injectable()
export class ShipmentDispatchQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShipmentDispatchQueueService.name);
  private queue!: Queue<DispatchPayload>;
  private worker!: Worker<DispatchPayload>;
  private retryTimer?: NodeJS.Timeout;
  private redisUnavailableLogged = false;
  private readonly workerEnabled: boolean;

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, private readonly fedex: FedexValidationService) {
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
    if (!this.queue) return false;
    try {
      await this.queue.add('dispatch-shipment', { orderId }, { jobId: orderId, attempts: 1, removeOnComplete: true, removeOnFail: true });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知队列错误';
      if (!message.includes('already exists')) {
        this.logger.warn(`面单任务将在 Redis 恢复后重新投递：${message}`);
        return false;
      }
      return true;
    }
  }

  private async process(orderId: string) {
    const claim = await this.prisma.shipmentDispatchJob.updateMany({ where: { orderId, status: ShipmentDispatchJobStatus.PENDING, order: { shipmentStatus: ShipmentStatus.SUBMITTED } }, data: { status: ShipmentDispatchJobStatus.PROCESSING, attempts: { increment: 1 }, startedAt: new Date(), claimedAt: new Date(), errorMessage: null } });
    if (claim.count !== 1) return;
    try {
      await this.fedex.create(orderId);
      await this.prisma.shipmentDispatchJob.update({ where: { orderId }, data: { status: ShipmentDispatchJobStatus.COMPLETED, completedAt: new Date() } });
    } catch (error) {
      const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { shipmentStatus: true } });
      const status = order?.shipmentStatus === ShipmentStatus.UNKNOWN ? ShipmentDispatchJobStatus.UNKNOWN : ShipmentDispatchJobStatus.FAILED;
      const message = error instanceof Error ? error.message : '未知供应商错误';
      await this.prisma.shipmentDispatchJob.update({ where: { orderId }, data: { status, errorMessage: message, completedAt: new Date() } });
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
        this.logger.warn('Redis 未启动，Open API 面单任务将保持待处理；Redis 恢复后会自动投递');
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
    this.logger.log(this.workerEnabled ? 'Open API 面单任务队列与 Worker 已连接 Redis' : 'Open API 面单任务队列已连接 Redis（当前实例不执行 Worker）');
  }

  private async enqueuePending() {
    if (!this.queue) return;
    const pending = await this.prisma.shipmentDispatchJob.findMany({ where: { status: ShipmentDispatchJobStatus.PENDING }, select: { orderId: true } });
    await Promise.all(pending.map(async (job) => {
      try { await this.queue.add('dispatch-shipment', { orderId: job.orderId }, { jobId: job.orderId, attempts: 1, removeOnComplete: true, removeOnFail: true }); }
      catch (error) { const message = error instanceof Error ? error.message : ''; if (!message.includes('already exists')) this.logger.warn(`待处理面单任务投递失败：${message || '未知错误'}`); }
    }));
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
