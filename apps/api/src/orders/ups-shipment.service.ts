import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { UpsOfficialConfig } from '../connectors/ups-official.config';
import { UpsOfficialConnector, UpsRequestError, UPS_SHIP_PATH, upsCancelPath } from '../connectors/ups-official.connector';
import { buildUpsShipment } from '../connectors/ups-official.mapper';
import { UpsLabelService } from './ups-label.service';

export function upsVoidConfirmed(body: any, trackingNumbers: string[]) {
  const r = body?.VoidShipmentResponse;
  if (r?.Response?.ResponseStatus?.Code !== '1' || r?.SummaryResult?.Status?.Code !== '1') return false;
  if (r.PackageLevelResults === undefined) return true;
  const packages = Array.isArray(r.PackageLevelResults) ? r.PackageLevelResults : [r.PackageLevelResults];
  return packages.length === trackingNumbers.length && trackingNumbers.every(n => packages.some((p: any) => p.TrackingNumber === n && p.Status?.Code === '1')) && packages.every((p: any) => p.Status?.Code === '1');
}
export function parseUpsShipment(body: any, count: number) {
  const r = body?.ShipmentResponse;
  const results = r?.ShipmentResults;
  const packages = Array.isArray(results?.PackageResults) ? results.PackageResults : results?.PackageResults ? [results.PackageResults] : [];
  if (r?.Response?.ResponseStatus?.Code !== '1' || !/^1Z[A-Z0-9]{16}$/.test(results?.ShipmentIdentificationNumber ?? '') || packages.length !== count || new Set(packages.map((p: any) => p.TrackingNumber)).size !== count || packages.some((p: any) => !/^1Z[A-Z0-9]{16}$/.test(p.TrackingNumber ?? '') || typeof p.ShippingLabel?.GraphicImage !== 'string' || !p.ShippingLabel.GraphicImage)) throw new UpsRequestError('CREATE', true, 200, '', 'UPS_RESPONSE_INCOMPLETE', 'UPS 响应缺少有效整票/逐箱运单号或原始标签，需人工核查，不得再次创建');
  return { shipmentId: results.ShipmentIdentificationNumber as string, packages: packages as Array<{ TrackingNumber: string; ShippingLabel: { GraphicImage: string } }> };
}

@Injectable()
export class UpsShipmentService {
  constructor(private readonly prisma: PrismaService, private readonly config: UpsOfficialConfig, private readonly connector: UpsOfficialConnector, private readonly labels: UpsLabelService) {}
  private async load(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { service: { include: { supplier: true } }, boxes: { include: { items: true } } } });
    if (!order) throw new NotFoundException('订单不存在');
    const s = order.supplierRouteSnapshot as any; const supplier = order.service.supplier;
    if (s?.driverCode !== 'UPS_OFFICIAL' || s.supplierId !== supplier.id || s.supplierCode !== supplier.code || s.environment !== supplier.environment || supplier.driverCode !== 'UPS_OFFICIAL') throw new ConflictException('UPS 订单连接/环境已改变，禁止向错误账号或环境调用');
    const profile = this.config.connection(s.supplierCode, s.environment);
    if (s.accountFingerprint !== this.config.accountFingerprint(profile)) throw new ConflictException('UPS 寄件账号已改变，请恢复该订单创建时的连接账号');
    const sequence: string[] = s.packageOrder ?? [];
    if (sequence.length !== order.boxes.length || new Set(sequence).size !== sequence.length || sequence.some(no => !order.boxes.some(box => box.boxNo === no))) throw new ConflictException('UPS 包裹顺序快照不完整，禁止发送');
    order.boxes.sort((a, b) => sequence.indexOf(a.boxNo) - sequence.indexOf(b.boxNo));
    return { order, profile };
  }
  async create(id: string, onStage?: (stage: 'VALIDATING' | 'CREATING') => Promise<void>) {
    const { order, profile } = await this.load(id);
    if (!order.service.enabled || !order.service.supplier.enabled) throw new ConflictException('UPS 服务或供应商已停用');
    if (order.shipmentStatus !== 'SUBMITTED') throw new ConflictException('订单已处理，不能重复创建');
    const payload = buildUpsShipment(order, profile);
    await onStage?.('VALIDATING');
    let token: string;
    try { token = await this.connector.getAccessToken(order.service.supplier.code, profile); }
    catch (e) { await this.audit(id, 'CREATE_SHIPMENT', false, { phase: 'OAUTH', shippingRequestSent: false }, undefined, e); throw e; }
    const claim = await this.prisma.order.updateMany({ where: { id, shipmentStatus: 'SUBMITTED' }, data: { shipmentStatus: 'GENERATING' } });
    if (claim.count !== 1) throw new ConflictException('订单正在处理或已处理');
    let sent = false;
    let result: Awaited<ReturnType<UpsOfficialConnector['create']>> | undefined;
    const requestAudit = { method: 'POST', path: UPS_SHIP_PATH, routeCode: (order.supplierRouteSnapshot as any).routeCode, payload: this.redact(payload, profile) };
    try {
      await onStage?.('CREATING'); sent = true;
      result = await this.connector.create(profile, token, payload);
      const parsed = parseUpsShipment(result.body, order.boxes.length);
      // Persist carrier success and original files before attempting any local image operation.
      await this.prisma.$transaction(async tx => {
        await tx.order.update({ where: { id }, data: { shipmentStatus: 'GENERATED', carrierTrackingNumber: parsed.shipmentId } });
        await tx.shipmentDispatchJob.updateMany({ where: { orderId: id }, data: { stage: 'PDF_PROCESSING', reasonCode: 'LABEL_PROCESSING_FAILED', publicMessage: '运单已生成，正在本地处理 PDF；如处理中断可再次预览/下载恢复' } });
        for (const [index, piece] of parsed.packages.entries()) {
          const box = order.boxes[index]!; const source = Buffer.from(piece.ShippingLabel.GraphicImage, 'base64');
          await tx.orderBox.update({ where: { id: box.id }, data: { carrierTrackingNumber: piece.TrackingNumber } });
          await tx.shipmentLabel.create({ data: { orderId: id, boxId: box.id, trackingNumber: piece.TrackingNumber, contentType: 'image/gif', content: source, sourceContentType: 'image/gif', sourceContent: source } });
        }
        await tx.connectorCallLog.create({ data: { orderId: id, driverCode: 'UPS_OFFICIAL', operation: 'CREATE_SHIPMENT', status: 'SUCCESS', httpStatus: result!.status, requestPayload: { ...requestAudit, transactionId: result!.transactionId } as any, responsePayload: this.redact(result!.body, profile) } });
      });
    } catch (e) {
      const unknown = sent && (!(e instanceof UpsRequestError) || e.unknown);
      await this.prisma.order.updateMany({ where: { id, shipmentStatus: 'GENERATING' }, data: { shipmentStatus: unknown ? 'UNKNOWN' : 'FAILED' } });
      await this.audit(id, 'CREATE_SHIPMENT', false, { ...requestAudit, transactionId: result?.transactionId }, result ? this.redact(result.body, profile) : undefined, e);
      throw e;
    }
    const saved = await this.prisma.shipmentLabel.findMany({ where: { orderId: id } });
    for (const label of saved) await this.labels.ensure(label);
    return { orderId: id, labelCount: saved.length };
  }
  async cancel(id: string, operatorId?: string) {
    const { order, profile } = await this.load(id);
    const local = order.shipmentStatus === 'SUBMITTED' || order.shipmentStatus === 'FAILED';
    if (!local && order.shipmentStatus !== 'GENERATED') throw new ConflictException('当前订单不可取消；正在处理、结果未知或已交运的订单需人工核查');
    if (!local && !order.carrierTrackingNumber) throw new ConflictException('缺少 UPS 整票运单号，不能取消');
    const claim = await this.prisma.order.updateMany({ where: { id, shipmentStatus: order.shipmentStatus }, data: { shipmentStatus: 'GENERATING' } });
    if (claim.count !== 1) throw new ConflictException('订单状态已改变，请刷新');
    let sent = false; let result: any;
    const request = { method: local ? 'LOCAL' : 'DELETE', path: local ? null : upsCancelPath(order.carrierTrackingNumber!), shipmentId: order.carrierTrackingNumber, wholeShipment: true, operatorId };
    try {
      if (!local) {
        const token = await this.connector.getAccessToken(order.service.supplier.code, profile);
        sent = true; result = await this.connector.cancel(profile, token, order.carrierTrackingNumber!);
        if (!upsVoidConfirmed(result.body, order.boxes.map(box => box.carrierTrackingNumber!).filter(Boolean))) throw new UpsRequestError('CANCEL', true, result.status, result.transactionId, 'UPS_CANCEL_UNCONFIRMED', '未明确确认整票取消，请人工核查');
      }
      await this.prisma.$transaction(async tx => {
        await tx.order.update({ where: { id }, data: { shipmentStatus: 'CANCELLED', feeStatus: 'RECONCILIATION_PENDING' } });
        await tx.cancellationRefundCase.upsert({ where: { orderId: id }, update: {}, create: { orderId: id, currency: order.currency, refundAmount: order.prechargedAmount, createdById: operatorId } });
        await tx.connectorCallLog.create({ data: { orderId: id, driverCode: 'UPS_OFFICIAL', operation: 'CANCEL_SHIPMENT', status: 'SUCCESS', httpStatus: result?.status, requestPayload: { ...request, transactionId: result?.transactionId } as any, responsePayload: result ? this.redact(result.body, profile) : { cancelled: true, localOnly: true } } });
        await tx.shipmentDispatchJob.updateMany({ where: { orderId: id }, data: { status: 'COMPLETED', stage: 'CANCELLED', publicMessage: '订单已取消，等待会计确认退款', completedAt: new Date() } });
      });
      return { orderId: id, cancelled: true, supplierCancelled: !local, requiresFinanceRefund: true };
    } catch (e) {
      const unknown = sent && (!(e instanceof UpsRequestError) || e.unknown);
      await this.prisma.order.updateMany({ where: { id, shipmentStatus: 'GENERATING' }, data: { shipmentStatus: unknown ? 'UNKNOWN' : order.shipmentStatus } });
      await this.audit(id, 'CANCEL_SHIPMENT', false, request, result ? this.redact(result.body, profile) : undefined, e); throw e;
    }
  }
  private redact(value: unknown, p: { shipperNumber: string; clientId: string; clientSecret: string }): Prisma.InputJsonValue {
    const visit = (v: any): any => Array.isArray(v) ? v.map(visit) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, /GraphicImage|HTMLImage|AccountNumber|ShipperNumber|Authorization|access_token/i.test(k) ? '[REDACTED]' : visit(val)])) : typeof v === 'string' ? [p.shipperNumber, p.clientId, p.clientSecret].filter(Boolean).reduce((s, secret) => s.split(secret).join('[REDACTED]'), v) : v;
    return visit(value);
  }
  private audit(orderId: string, operation: 'CREATE_SHIPMENT' | 'CANCEL_SHIPMENT', success: boolean, request: unknown, response?: unknown, error?: unknown) {
    return this.prisma.connectorCallLog.create({ data: { orderId, driverCode: 'UPS_OFFICIAL', operation, status: success ? 'SUCCESS' : 'FAILED', httpStatus: error instanceof UpsRequestError ? error.upstreamStatus : null, requestPayload: { ...(request as any), ...(error instanceof UpsRequestError ? { transactionId: error.transactionId, phase: error.phase } : {}) }, responsePayload: response as any, errorMessage: error instanceof UpsRequestError ? error.message : error ? '本地处理异常；如已发出请求，请人工核查，禁止自动重试' : undefined } });
  }
}
