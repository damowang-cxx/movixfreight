import { BadGatewayException, BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConnectorCallStatus, ConnectorOperation, Prisma, ShipmentStatus } from '@prisma/client';
import { FedexRelayConfig } from '../connectors/fedex-relay.config';
import { FedexRelayConnector } from '../connectors/fedex-relay.connector';
import { FedexRelayMapper } from '../connectors/fedex-relay.mapper';
import { PrismaService } from '../database/prisma.service';
import { CancellationRefundService, withCancellationTransaction } from './cancellation-refund.service';

@Injectable()
export class FedexValidationService {
  constructor(private readonly prisma: PrismaService, private readonly mapper: FedexRelayMapper, private readonly connector: FedexRelayConnector, private readonly config: FedexRelayConfig, private readonly refunds: CancellationRefundService) {}

  async validate(orderId: string) {
    const order = await this.load(orderId);
    this.assertFedexChannel(order);
    const payload = await this.mapper.buildShipment(order);
    if (order.boxes.length > 1) throw new BadRequestException('FedEx 预校验接口只支持单箱订单；多箱订单请使用创建面单接口，供应商会在创建时校验整票');
    try {
      const token = await this.connector.getAccessToken(order.service.supplier.code);
      const response = await this.connector.validate(token.accessToken, payload, order.service.supplier.code);
      await this.log(orderId, ConnectorOperation.VALIDATE_SHIPMENT, ConnectorCallStatus.SUCCESS, payload, response);
      return { valid: true, orderId, response };
    } catch (error) {
      await this.log(orderId, ConnectorOperation.VALIDATE_SHIPMENT, ConnectorCallStatus.FAILED, payload, undefined, this.message(error));
      throw error;
    }
  }

  async create(orderId: string, onStage?: (stage: 'VALIDATING' | 'CREATING') => Promise<void>) {
    const order = await this.load(orderId);
    this.assertFedexChannel(order);
    if (order.shipmentStatus !== ShipmentStatus.SUBMITTED) throw new ConflictException('只有“已下单”的订单可以创建 FedEx 面单');
    const payload = await this.mapper.buildShipment(order);
    // FedEx Validate Shipment only supports one package. The Create Shipment
    // endpoint validates multi-piece shipments while creating their labels.
    if (order.boxes.length === 1) {
      try {
        await onStage?.('VALIDATING');
        const token = await this.connector.getAccessToken(order.service.supplier.code);
        const validation = await this.connector.validate(token.accessToken, payload, order.service.supplier.code);
        await this.log(orderId, ConnectorOperation.VALIDATE_SHIPMENT, ConnectorCallStatus.SUCCESS, payload, validation);
      } catch (error) {
        const status = this.isUnknown(error) ? ShipmentStatus.UNKNOWN : ShipmentStatus.FAILED;
        await this.prisma.order.updateMany({ where: { id: orderId, shipmentStatus: ShipmentStatus.SUBMITTED }, data: { shipmentStatus: status } });
        await this.log(orderId, ConnectorOperation.VALIDATE_SHIPMENT, ConnectorCallStatus.FAILED, payload, undefined, this.message(error));
        throw error;
      }
    }

    const claim = await this.prisma.order.updateMany({ where: { id: orderId, shipmentStatus: ShipmentStatus.SUBMITTED }, data: { shipmentStatus: ShipmentStatus.GENERATING } });
    if (claim.count !== 1) throw new ConflictException('订单正在生成或已处理，不能重复创建面单');
    try {
      await onStage?.('CREATING');
      const token = await this.connector.getAccessToken(order.service.supplier.code);
      const result = await this.connector.createShipment(token.accessToken, payload, order.service.supplier.code);
      const parsed = this.connector.extractLabels(result);
      if (!parsed.masterTrackingNumber && !parsed.labels.length) throw new BadGatewayException('供应商响应未包含运单号或面单');
      const tracking = parsed.masterTrackingNumber ?? parsed.labels[0]?.trackingNumber;
      const sanitized = structuredClone(result);
      for (const shipment of sanitized?.output?.transactionShipments ?? []) for (const piece of shipment.pieceResponses ?? []) for (const document of piece.packageDocuments ?? []) delete document.encodedLabel;
      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: orderId }, data: { shipmentStatus: ShipmentStatus.GENERATED, carrierTrackingNumber: tracking } });
        if (parsed.labels.length) await tx.shipmentLabel.createMany({ data: parsed.labels.map((label) => ({ orderId, trackingNumber: label.trackingNumber, contentType: label.contentType, content: Buffer.from(label.encodedLabel, 'base64') })) });
        await tx.connectorCallLog.create({ data: { orderId, driverCode: 'FEDEX_RELAY', operation: ConnectorOperation.CREATE_SHIPMENT, status: ConnectorCallStatus.SUCCESS, httpStatus: 200, requestPayload: payload as Prisma.InputJsonValue, responsePayload: sanitized as Prisma.InputJsonValue } });
      });
      return { orderId, trackingNumber: tracking, labelCount: parsed.labels.length };
    } catch (error) {
      const status = this.isUnknown(error) ? ShipmentStatus.UNKNOWN : ShipmentStatus.FAILED;
      await this.prisma.order.update({ where: { id: orderId }, data: { shipmentStatus: status } });
      await this.log(orderId, ConnectorOperation.CREATE_SHIPMENT, ConnectorCallStatus.FAILED, payload, undefined, this.message(error));
      throw error;
    }
  }

  /**
   * 系统订单尚未向承运商成功创建时，可直接标记取消；已经生成面单的订单则必须由
   * FedEx 明确确认取消。网络超时或未知结果绝不自动重试或退款。
   */
  async cancel(orderId: string, createdById?: string) {
    const order = await this.load(orderId);
    this.assertFedexChannel(order);
    this.refunds.assertRefundable(order);
    if (order.shipmentStatus === ShipmentStatus.RECEIVED) throw new ConflictException('订单已收货，不能取消运单');
    if (order.shipmentStatus === ShipmentStatus.GENERATING) throw new ConflictException('订单正在生成面单，请稍后再试');
    if (order.shipmentStatus === ShipmentStatus.UNKNOWN) throw new ConflictException('供应商处理结果未知，禁止自动取消，请人工向供应商核查');
    if (order.shipmentStatus === ShipmentStatus.CANCELLED) throw new ConflictException('订单已取消');
    if (order.shipmentStatus === ShipmentStatus.RETURNED) throw new ConflictException('退件订单不能通过 FedEx 取消接口处理');

    if (order.shipmentStatus === ShipmentStatus.SUBMITTED || order.shipmentStatus === ShipmentStatus.FAILED) {
      const claim = await this.prisma.order.updateMany({ where: { id: orderId, shipmentStatus: order.shipmentStatus }, data: { shipmentStatus: ShipmentStatus.GENERATING } });
      if (claim.count !== 1) throw new ConflictException('订单状态已变化，请刷新后重试');
      try {
        await withCancellationTransaction(this.prisma, async (tx) => {
          await this.refunds.complete(tx, order, createdById);
          await tx.connectorCallLog.create({ data: { orderId, driverCode: 'FEDEX_RELAY', operation: ConnectorOperation.CANCEL_SHIPMENT, status: ConnectorCallStatus.SUCCESS, requestPayload: { localOnly: true, reason: '尚未取得有效 FedEx 面单' }, responsePayload: { cancelledShipment: true, mode: 'LOCAL' } } });
          await tx.shipmentDispatchJob.updateMany({ where: { orderId }, data: { status: 'COMPLETED', stage: 'CANCELLED', publicMessage: '订单已取消，预扣款已退回余额', completedAt: new Date() } });
        });
        return { orderId, cancelled: true, supplierCancelled: false, refunded: true };
      } catch (error) {
        await this.prisma.order.updateMany({ where: { id: orderId, shipmentStatus: ShipmentStatus.GENERATING }, data: { shipmentStatus: order.shipmentStatus } });
        throw error;
      }
    }

    if (order.shipmentStatus !== ShipmentStatus.GENERATED) throw new ConflictException('当前订单状态不允许取消');
    if (!order.carrierTrackingNumber) throw new ConflictException('订单缺少 FedEx 转单号，不能安全取消');

    const claim = await this.prisma.order.updateMany({ where: { id: orderId, shipmentStatus: ShipmentStatus.GENERATED }, data: { shipmentStatus: ShipmentStatus.GENERATING } });
    if (claim.count !== 1) throw new ConflictException('订单状态已变化或正在处理，请刷新后重试');
    const requestPayload = { trackingNumber: order.carrierTrackingNumber, deletionControl: 'DELETE_ALL_PACKAGES' };
    let cancelRequestSent = false;
    try {
      const token = await this.connector.getAccessToken(order.service.supplier.code);
      cancelRequestSent = true;
      const response = await this.connector.cancelShipment(token.accessToken, order.carrierTrackingNumber, order.service.supplier.code);
      if (!this.isCancellationConfirmed(response)) throw new BadGatewayException({ message: 'FedEx 未返回明确的取消成功标识，订单已标记为结果未知，请人工核查', status: 502 });
      await withCancellationTransaction(this.prisma, async (tx) => {
        await this.refunds.complete(tx, order, createdById);
        await tx.connectorCallLog.create({ data: { orderId, driverCode: 'FEDEX_RELAY', operation: ConnectorOperation.CANCEL_SHIPMENT, status: ConnectorCallStatus.SUCCESS, httpStatus: 200, requestPayload: requestPayload as Prisma.InputJsonValue, responsePayload: response as Prisma.InputJsonValue } });
        await tx.shipmentDispatchJob.updateMany({ where: { orderId }, data: { status: 'COMPLETED', stage: 'CANCELLED', publicMessage: '订单已取消，预扣款已退回余额', completedAt: new Date() } });
      });
      return { orderId, cancelled: true, supplierCancelled: true, refunded: true };
    } catch (error) {
      // OAuth 失败时尚未把取消请求发给供应商，订单仍然可以安全地再次取消。
      // 一旦已发出取消请求却超时或收到未知响应，不能猜测结果，更不能自动重试。
      const status = cancelRequestSent && this.isUnknown(error) ? ShipmentStatus.UNKNOWN : ShipmentStatus.GENERATED;
      await this.prisma.order.update({ where: { id: orderId }, data: { shipmentStatus: status } });
      await this.log(orderId, ConnectorOperation.CANCEL_SHIPMENT, ConnectorCallStatus.FAILED, requestPayload, undefined, this.message(error));
      throw error;
    }
  }

  private async load(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { service: { include: { supplier: true } }, boxes: { include: { items: true } } } });
    if (!order) throw new NotFoundException('订单不存在');
    return order;
  }

  private assertFedexChannel(order: Awaited<ReturnType<FedexValidationService['load']>>) {
    const snapshot = order.supplierRouteSnapshot as any;
    if (snapshot?.driverCode && (snapshot.driverCode !== 'FEDEX_RELAY' || snapshot.environment !== order.service.supplier.environment || snapshot.supplierId !== order.service.supplier.id || snapshot.supplierCode !== order.service.supplier.code)) throw new ConflictException('订单创建后的供应商连接或环境被修改，不能调用 FedEx');
    const config = this.config.status(order.service.supplier.code, order.service.supplier.environment === 'PRODUCTION');
    if (order.service.supplier.driverCode !== 'FEDEX_RELAY' || !order.service.supplier.enabled || !config.configured || config.environment.toUpperCase() !== order.service.supplier.environment) throw new ConflictException('FedEx 供应商连接环境与当前连接配置不匹配，不能创建面单');
    this.config.assertReady(order.service.supplier.code);
  }

  private isUnknown(error: unknown) {
    if (!(error instanceof BadGatewayException)) return true;
    const response = error.getResponse() as { status?: number; statusCode?: number };
    const status = response.status ?? response.statusCode;
    return !status || status >= 500;
  }

  private isCancellationConfirmed(response: any) {
    return response?.output?.cancelledShipment === true || response?.cancelledShipment === true || response?.output?.shipment?.cancelledShipment === true;
  }

  private message(error: unknown) {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string') return response;
      const body = response as { message?: string | string[]; errors?: Array<{ code?: string; message?: string }> };
      const primary = Array.isArray(body.message) ? body.message.join('；') : body.message ?? error.message;
      const details = Array.isArray(body.errors)
        ? body.errors.map((item) => `${item.code ? `[${item.code}] ` : ''}${item.message ?? ''}`.trim()).filter(Boolean).join('；')
        : '';
      return details && !String(primary).includes(details) ? `${primary}：${details}` : String(primary);
    }
    return error instanceof Error ? error.message : '未知供应商错误';
  }
  private async log(orderId: string, operation: ConnectorOperation, status: ConnectorCallStatus, payload: unknown, response?: unknown, errorMessage?: string) { await this.prisma.connectorCallLog.create({ data: { orderId, driverCode: 'FEDEX_RELAY', operation, status, httpStatus: status === ConnectorCallStatus.SUCCESS ? 200 : null, requestPayload: payload as Prisma.InputJsonValue, responsePayload: response as Prisma.InputJsonValue, errorMessage } }); }
}
