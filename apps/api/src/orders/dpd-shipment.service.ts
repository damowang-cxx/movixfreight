import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DpdRelayConfig, type DpdRelayProfile } from '../connectors/dpd-relay.config';
import { DpdRelayConnector, DpdRequestError, DPD_PATHS } from '../connectors/dpd-relay.connector';
import { buildDpdShipment, dpdPdf, dpdRejection, dpdSuccess } from '../connectors/dpd-relay.mapper';

@Injectable()
export class DpdShipmentService {
  constructor(private readonly prisma: PrismaService, private readonly config: DpdRelayConfig, private readonly connector: DpdRelayConnector) {}
  private async load(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { service: { include: { supplier: true } }, boxes: { include: { items: true } } } });
    if (!order) throw new NotFoundException('订单不存在');
    const snapshot = order.supplierRouteSnapshot as any; const supplier = order.service.supplier;
    if (snapshot?.driverCode !== 'DPD_RELAY_UK' || supplier.driverCode !== 'DPD_RELAY_UK' || snapshot.supplierId !== supplier.id || snapshot.supplierCode !== supplier.code || snapshot.environment !== supplier.environment) throw new ConflictException('DPD 原供应商连接或环境已改变');
    const profile = this.config.connection(supplier.code, supplier.environment);
    if (snapshot.accountFingerprint !== this.config.accountFingerprint(profile)) throw new ConflictException('DPD 原账号或发件仓已改变，请恢复订单创建时的配置');
    return { order, profile };
  }
  async create(id: string, onStage?: (stage: 'VALIDATING' | 'CREATING') => Promise<void>) {
    const { order, profile } = await this.load(id);
    if (!order.service.enabled || !order.service.supplier.enabled) throw new ConflictException('DPD 服务或连接已停用');
    if (order.shipmentStatus !== 'SUBMITTED') throw new ConflictException('订单已处理，不能重复建单');
    const payload = buildDpdShipment(order, profile);
    await onStage?.('VALIDATING');
    const claim = await this.prisma.order.updateMany({ where: { id, shipmentStatus: 'SUBMITTED' }, data: { shipmentStatus: 'GENERATING' } });
    if (claim.count !== 1) throw new ConflictException('订单正在处理或已处理');
    let sent = false; let awbNo: string | null = null; let httpStatus: number | null = null; let createdBody: unknown;
    try {
      await onStage?.('CREATING'); sent = true;
      const created = await this.connector.create(profile, payload);
      httpStatus = created.status; createdBody = created.body;
      awbNo = String(created.body?.AWBNo ?? '').trim() || null;
      if (!dpdSuccess(created.body)) {
        const rejection = dpdRejection(created.body);
        const detail = this.safeResponseText(rejection.messages.join('；') || created.body?.APIError || created.body?.Response?.APIError || created.body?.Message || created.body?.Response?.Status || created.body?.Status || '', profile);
        throw new DpdRequestError('CREATE', Boolean(awbNo) || !rejection.explicit, created.status,
          String(created.body?.ErrorCode ?? created.body?.Response?.ErrorCode ?? 'UNEXPECTED_RESPONSE'),
          rejection.explicit ? detail || '渠道明确拒绝建单' : `${detail ? `${detail}；` : ''}渠道响应未明确确认建单成功或失败，请按 CustomerRefNo 人工核查`);
      }
      if (!awbNo) throw new DpdRequestError('CREATE', true, created.status, 'MISSING_AWB', '渠道报告成功但未返回 AWBNo，请人工核查');
      if (created.body.RefNo && String(created.body.RefNo).trim() !== order.orderNo) throw new DpdRequestError('CREATE', true, created.status, 'REFERENCE_MISMATCH', '渠道返回的参考号与订单号不一致，请人工核查');
      let pdf = dpdPdf(created.body);
      if (!pdf) {
        const printed = await this.connector.print(profile, awbNo);
        if (dpdSuccess(printed.body) && String(printed.body?.AWBNo ?? '').trim() === awbNo) pdf = dpdPdf(printed.body);
      }
      if (!pdf) throw new DpdRequestError('CREATE', true, created.status, 'MISSING_LABEL', '运单已生成但没有可用 PDF 面单，请通过 AWBNo 人工核查');
      await this.prisma.$transaction(async tx => {
        await tx.order.update({ where: { id }, data: { shipmentStatus: 'GENERATED', carrierTrackingNumber: awbNo } });
        await tx.orderBox.update({ where: { id: order.boxes[0]!.id }, data: { carrierTrackingNumber: awbNo } });
        await tx.shipmentLabel.create({ data: { orderId: id, boxId: order.boxes[0]!.id, trackingNumber: awbNo, contentType: 'application/pdf', content: new Uint8Array(pdf) } });
        await tx.connectorCallLog.create({ data: { orderId: id, driverCode: 'DPD_RELAY_UK', operation: 'CREATE_SHIPMENT', status: 'SUCCESS', httpStatus: created.status, requestPayload: this.auditRequest(order, payload, profile), responsePayload: this.auditResponse(created.body, profile) } });
      });
      return { orderId: id, labelCount: 1 };
    } catch (error) {
      if (error instanceof DpdRequestError) {
        httpStatus ??= error.upstreamStatus;
        if (createdBody === undefined) createdBody = error.responseBody;
      }
      const unknown = Boolean(awbNo) || (sent && (!(error instanceof DpdRequestError) || error.unknown));
      await this.prisma.order.updateMany({ where: { id, shipmentStatus: 'GENERATING' }, data: { shipmentStatus: unknown ? 'UNKNOWN' : 'FAILED', ...(awbNo ? { carrierTrackingNumber: awbNo } : {}) } });
      await this.prisma.connectorCallLog.create({ data: { orderId: id, driverCode: 'DPD_RELAY_UK', operation: 'CREATE_SHIPMENT', status: 'FAILED', httpStatus, requestPayload: this.auditRequest(order, payload, profile), responsePayload: createdBody === undefined ? Prisma.JsonNull : this.auditResponse(createdBody, profile), errorMessage: error instanceof Error ? error.message.slice(0, 500) : '未知建单错误' } });
      throw error;
    }
  }
  async reprint(id: string) {
    const { order, profile } = await this.load(id);
    if (!order.carrierTrackingNumber || !['GENERATED', 'UNKNOWN'].includes(order.shipmentStatus)) throw new ConflictException('缺少可补打的渠道 AWBNo');
    const result = await this.connector.print(profile, order.carrierTrackingNumber);
    const pdf = dpdSuccess(result.body) ? dpdPdf(result.body) : null;
    if (!pdf || String(result.body?.AWBNo ?? '').trim() !== order.carrierTrackingNumber) throw new DpdRequestError('PRINT', false, result.status, 'MISSING_LABEL', '渠道未返回与原运单号匹配的 PDF 面单');
    await this.prisma.$transaction(async tx => {
      await tx.shipmentLabel.upsert({ where: { boxId: order.boxes[0]!.id }, update: { content: new Uint8Array(pdf), contentType: 'application/pdf', trackingNumber: order.carrierTrackingNumber }, create: { orderId: id, boxId: order.boxes[0]!.id, trackingNumber: order.carrierTrackingNumber, contentType: 'application/pdf', content: new Uint8Array(pdf) } });
      if (order.shipmentStatus === 'UNKNOWN') await tx.order.update({ where: { id }, data: { shipmentStatus: 'GENERATED' } });
      await tx.orderBox.update({ where: { id: order.boxes[0]!.id }, data: { carrierTrackingNumber: order.carrierTrackingNumber } });
      await tx.shipmentDispatchJob.updateMany({ where: { orderId: id }, data: { status: 'COMPLETED', stage: 'READY', reasonCode: 'LABEL_READY', publicMessage: '面单已补打', completedAt: new Date() } });
      await tx.connectorCallLog.create({ data: { orderId: id, driverCode: 'DPD_RELAY_UK', operation: 'QUERY_SHIPMENT', status: 'SUCCESS', httpStatus: result.status, requestPayload: { path: DPD_PATHS.PRINT, AWBNo: order.carrierTrackingNumber }, responsePayload: this.auditResponse(result.body, profile) } });
    });
    return { orderId: id, labelCount: 1 };
  }
  async cancel(id: string, operatorId?: string) {
    const { order, profile } = await this.load(id);
    const local = order.shipmentStatus === 'SUBMITTED' || order.shipmentStatus === 'FAILED';
    if (!local && order.shipmentStatus !== 'GENERATED') throw new ConflictException('订单正在处理、结果未知或已交运，需人工核查');
    if (!local && !order.carrierTrackingNumber) throw new ConflictException('缺少渠道 AWBNo，不能作废');
    const claim = await this.prisma.order.updateMany({ where: { id, shipmentStatus: order.shipmentStatus }, data: { shipmentStatus: 'GENERATING' } });
    if (claim.count !== 1) throw new ConflictException('订单状态已改变，请刷新');
    let sent = false; let status: number | null = null;
    try {
      let response: any = { localOnly: true };
      if (!local) {
        sent = true;
        const result = await this.connector.cancel(profile, order.carrierTrackingNumber!);
        status = result.status; response = result.body;
        if (String(result.body?.Response?.StatusCode) !== '0') throw new DpdRequestError('CANCEL', true, result.status, 'CANCEL_UNCONFIRMED', '渠道未明确确认作废，请人工核查');
      }
      await this.prisma.$transaction(async tx => {
        await tx.order.update({ where: { id }, data: { shipmentStatus: 'CANCELLED', feeStatus: 'RECONCILIATION_PENDING' } });
        await tx.cancellationRefundCase.upsert({ where: { orderId: id }, update: {}, create: { orderId: id, currency: order.currency, refundAmount: order.prechargedAmount, createdById: operatorId } });
        await tx.shipmentDispatchJob.updateMany({ where: { orderId: id }, data: { status: 'COMPLETED', stage: 'CANCELLED', publicMessage: '订单已取消，等待会计确认退款', completedAt: new Date() } });
        await tx.connectorCallLog.create({ data: { orderId: id, driverCode: 'DPD_RELAY_UK', operation: 'CANCEL_SHIPMENT', status: 'SUCCESS', httpStatus: status, requestPayload: { path: local ? null : DPD_PATHS.CANCEL, AWBNo: order.carrierTrackingNumber, operatorId }, responsePayload: this.auditResponse(response, profile) } });
      });
      return { orderId: id, cancelled: true, supplierCancelled: !local, requiresFinanceRefund: true };
    } catch (error) {
      const unknown = sent && (!(error instanceof DpdRequestError) || error.unknown);
      await this.prisma.order.updateMany({ where: { id, shipmentStatus: 'GENERATING' }, data: { shipmentStatus: unknown ? 'UNKNOWN' : order.shipmentStatus } });
      await this.prisma.connectorCallLog.create({ data: { orderId: id, driverCode: 'DPD_RELAY_UK', operation: 'CANCEL_SHIPMENT', status: 'FAILED', httpStatus: status, requestPayload: { path: DPD_PATHS.CANCEL, AWBNo: order.carrierTrackingNumber, operatorId }, errorMessage: error instanceof Error ? error.message.slice(0, 500) : '未知作废错误' } });
      throw error;
    }
  }
  private auditRequest(order: { orderNo: string }, payload: ReturnType<typeof buildDpdShipment>, profile: DpdRelayProfile): Prisma.InputJsonValue {
    return { path: DPD_PATHS.CREATE, CustomerRefNo: order.orderNo, payload: this.auditJson(payload, profile) };
  }
  private safeResponseText(value: unknown, profile?: DpdRelayProfile, limit = 300) {
    let result = String(value ?? '');
    for (const secret of [profile?.userId, profile?.password, profile?.customerCode]) if (secret) result = result.replaceAll(secret, '[REDACTED]');
    return result.slice(0, limit);
  }
  private auditResponse(body: any, profile?: DpdRelayProfile): Prisma.InputJsonValue {
    return this.auditJson(body, profile);
  }
  private auditJson(value: unknown, profile?: DpdRelayProfile): Prisma.InputJsonValue {
    if (value === null || value === undefined) return { value: null };
    const sensitiveKey = /password|secret|token|authorization|api.?key|^userid$|^customercode$/i;
    const attachmentKey = /pdfdownload|base64|labelcontent|filecontent/i;
    const visit = (item: unknown, depth: number): Prisma.JsonValue => {
      if (item === null || item === undefined) return null;
      if (typeof item === 'string') {
        if (item.length > 800 && /^[A-Za-z0-9+/]+={0,2}$/.test(item)) return `[省略疑似 Base64，${item.length} 字符]`;
        const result = this.safeResponseText(item, profile, 1000);
        return item.length > 1000 ? `${result}…[已截断]` : result;
      }
      if (typeof item === 'number' || typeof item === 'boolean') return item;
      if (depth >= 5) return '[嵌套层级已截断]';
      if (Array.isArray(item)) return item.slice(0, 30).map(child => visit(child, depth + 1));
      if (typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 60).map(([key, child]) => [key, sensitiveKey.test(key) ? '[已脱敏]' : attachmentKey.test(key) ? '[已省略附件内容]' : visit(child, depth + 1)]));
      return String(item).slice(0, 300);
    };
    return visit(value, 0) as Prisma.InputJsonValue;
  }
}
