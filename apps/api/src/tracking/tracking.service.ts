import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { FedexRelayConfig } from '../connectors/fedex-relay.config';
import { FedexRelayConnector } from '../connectors/fedex-relay.connector';
import { UpsOfficialConfig } from '../connectors/ups-official.config';
import { UpsOfficialConnector, UpsRequestError } from '../connectors/ups-official.connector';
import { mapFedexTrack, mapUpsTrack, type TrackingResult, type TrackingStatus } from './tracking.mapper';

const TERMINAL: TrackingStatus[] = ['DELIVERED', 'RETURNED'];
const ORDER_ACTIVE = ['GENERATED', 'RECEIVED', 'RETURNED'] as const;
const summaryStatus = (statuses: string[]): string => {
  if (!statuses.length) return 'LABEL_CREATED';
  if (statuses.every(status => status === 'DELIVERED')) return 'DELIVERED';
  for (const status of ['EXCEPTION', 'RETURNING', 'RETURNED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'UNKNOWN', 'LABEL_CREATED']) if (statuses.includes(status)) return status;
  return 'UNKNOWN';
};

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fedexConfig: FedexRelayConfig,
    private readonly fedex: FedexRelayConnector,
    private readonly upsConfig: UpsOfficialConfig,
    private readonly ups: UpsOfficialConnector,
  ) {}

  async listSummaries(orderIds: string[], admin: boolean) {
    if (!orderIds.length) return new Map<string, any>();
    const records = await this.prisma.shipmentTracking.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, status: true, syncStatus: true, lastSyncedAt: true, publicMessage: true, technicalError: true } });
    const grouped = new Map<string, typeof records>();
    for (const record of records) grouped.set(record.orderId, [...(grouped.get(record.orderId) ?? []), record]);
    return new Map(orderIds.map(orderId => {
      const rows = grouped.get(orderId) ?? [];
      const newest = rows.map(row => row.lastSyncedAt).filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return [orderId, { status: rows.length ? summaryStatus(rows.map(row => row.status)) : 'PENDING', syncStatus: rows.length ? rows.some(row => row.syncStatus === 'ERROR') ? 'ERROR' : rows.some(row => row.syncStatus === 'PROCESSING') ? 'PROCESSING' : rows.every(row => row.syncStatus === 'NO_EVENTS') ? 'NO_EVENTS' : 'READY' : 'PENDING', lastSyncedAt: newest, message: rows.find(row => row.syncStatus === 'ERROR')?.publicMessage ?? (rows.length ? null : '面单生成后开始同步轨迹'), ...(admin ? { technicalError: rows.find(row => row.technicalError)?.technicalError ?? null } : {}) }];
    }));
  }

  async statuses(idsText: string, customerId?: string) {
    const ids = [...new Set(idsText.split(',').map(id => id.trim()).filter(Boolean))];
    if (ids.length > 100) throw new BadRequestException('单次最多查询 100 个订单轨迹状态');
    const orders = await this.prisma.order.findMany({ where: { id: { in: ids }, ...(customerId ? { customerId } : {}) }, select: { id: true, shipmentStatus: true } });
    const summaries = await this.listSummaries(orders.map(order => order.id), !customerId);
    return orders.map(order => ({ orderId: order.id, tracking: { ...summaries.get(order.id), ...(order.shipmentStatus === 'CANCELLED' ? { status: 'CANCELLED', syncStatus: 'STOPPED' } : {}) } }));
  }

  async detail(orderId: string, customerId?: string, orderNo = false, admin = false) {
    const order = await this.prisma.order.findFirst({ where: { ...(orderNo ? { orderNo: orderId } : { id: orderId }), ...(customerId ? { customerId } : {}) }, select: { id: true, orderNo: true, shipmentStatus: true, carrierTrackingNumber: true, boxes: { select: { id: true, boxNo: true, carrierTrackingNumber: true } }, trackingRecords: { include: { box: { select: { boxNo: true } }, events: { orderBy: { occurredAt: 'desc' } } }, orderBy: { createdAt: 'asc' } } } });
    if (!order) throw new NotFoundException('运单不存在或无权访问');
    const summary = (await this.listSummaries([order.id], admin)).get(order.id);
    return { shipment_id: order.orderNo, transfer_number: order.carrierTrackingNumber, status: order.shipmentStatus === 'CANCELLED' ? 'CANCELLED' : summary.status, sync_status: order.shipmentStatus === 'CANCELLED' ? 'STOPPED' : summary.syncStatus, last_synced_at: summary.lastSyncedAt, message: summary.message, ...(admin ? { technical_error: summary.technicalError } : {}), packages: order.trackingRecords.map(record => ({ box_no: record.box?.boxNo ?? null, tracking_number: record.trackingNumber, status: record.status, carrier_status_code: record.carrierStatusCode, carrier_description: record.carrierDescription, sync_status: record.syncStatus, last_synced_at: record.lastSyncedAt, next_sync_at: record.nextSyncAt, message: record.publicMessage, ...(admin ? { technical_error: record.technicalError } : {}), events: record.events.map(event => ({ occurred_at: event.occurredAt, status: event.status, carrier_status_code: event.carrierStatusCode, description: event.description, city: event.city, state: event.state, country_code: event.countryCode })) })) };
  }

  async requestRefresh(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, shipmentStatus: true, trackingRecords: { select: { id: true, refreshRequestedAt: true } } } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.shipmentStatus === 'CANCELLED') throw new ConflictException('已取消订单不再同步轨迹');
    if (!order.trackingRecords.length) { await this.ensureOrderTargets(orderId); }
    const rows = await this.prisma.shipmentTracking.findMany({ where: { orderId }, select: { id: true, refreshRequestedAt: true } });
    if (!rows.length) throw new ConflictException('尚未取得承运商运单号，无法刷新轨迹');
    const eligible = await this.prisma.shipmentTracking.count({ where: { orderId, status: { notIn: TERMINAL } } });
    if (!eligible) throw new ConflictException('此订单轨迹已结束，无需再次查询承运商');
    const cutoff = new Date(Date.now() - 5 * 60_000);
    if (rows.some(row => row.refreshRequestedAt && row.refreshRequestedAt > cutoff)) throw new ConflictException('5 分钟内已请求刷新，请稍后查看');
    const refreshed = await this.prisma.shipmentTracking.updateMany({ where: { orderId, status: { notIn: TERMINAL }, syncStatus: { not: 'PROCESSING' }, OR: [{ refreshRequestedAt: null }, { refreshRequestedAt: { lte: cutoff } }] }, data: { nextSyncAt: new Date(), refreshRequestedAt: new Date(), syncStatus: 'PENDING', publicMessage: '已请求刷新轨迹' } });
    if (!refreshed.count) throw new ConflictException('轨迹正在同步或 5 分钟内已请求刷新，请稍后查看');
    return { queued: true, message: '已请求刷新轨迹；后台同步后可在订单详情查看' };
  }

  async ensureRecentTargets() {
    const cutoff = new Date(Date.now() - 90 * 86400_000);
    const orders = await this.prisma.order.findMany({ where: { createdAt: { gte: cutoff }, shipmentStatus: { in: [...ORDER_ACTIVE] }, trackingRecords: { none: {} }, OR: [{ labels: { some: { trackingNumber: { not: null } } } }, { boxes: { some: { carrierTrackingNumber: { not: null } } } }, { carrierTrackingNumber: { not: null } }] }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    for (const order of orders) await this.ensureOrderTargets(order.id);
  }

  private async ensureOrderTargets(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { service: { include: { supplier: true } }, boxes: true, labels: { select: { boxId: true, trackingNumber: true } } } });
    if (!order || !ORDER_ACTIVE.includes(order.shipmentStatus as any)) return;
    const driver = (order.supplierRouteSnapshot as any)?.driverCode ?? order.service.supplier.driverCode;
    if (!['UPS_OFFICIAL', 'FEDEX_RELAY'].includes(driver)) return;
    const targets = new Map<string, string | null>();
    for (const box of order.boxes) if (box.carrierTrackingNumber) targets.set(box.carrierTrackingNumber, box.id);
    for (const label of order.labels) if (label.trackingNumber) targets.set(label.trackingNumber, label.boxId ?? targets.get(label.trackingNumber) ?? null);
    if (!targets.size && order.carrierTrackingNumber) targets.set(order.carrierTrackingNumber, null);
    await this.prisma.$transaction(targets.size ? [...targets].map(([trackingNumber, boxId]) => this.prisma.shipmentTracking.upsert({ where: { orderId_trackingNumber: { orderId, trackingNumber } }, update: {}, create: { orderId, boxId, trackingNumber, driverCode: driver, nextSyncAt: new Date(), publicMessage: '面单已生成，等待承运商扫描' } })) : []);
  }

  async syncDue(limit = 10) {
    const due = await this.prisma.shipmentTracking.findMany({ where: { nextSyncAt: { lte: new Date() }, order: { shipmentStatus: { in: [...ORDER_ACTIVE] } } }, select: { id: true }, orderBy: { nextSyncAt: 'asc' }, take: limit });
    for (const row of due) await this.syncOne(row.id);
  }

  private async syncOne(id: string) {
    const now = new Date();
    const claim = await this.prisma.shipmentTracking.updateMany({ where: { id, nextSyncAt: { lte: now }, order: { shipmentStatus: { in: [...ORDER_ACTIVE] } } }, data: { syncStatus: 'PROCESSING', claimedAt: now, nextSyncAt: new Date(now.getTime() + 5 * 60_000) } });
    if (claim.count !== 1) return;
    const row = await this.prisma.shipmentTracking.findUniqueOrThrow({ where: { id }, include: { order: { include: { service: { include: { supplier: true } } } } } });
    const snapshot = row.order.supplierRouteSnapshot as any; const supplier = row.order.service.supplier;
    try {
      if (snapshot?.driverCode && (snapshot.driverCode !== supplier.driverCode || snapshot.supplierId !== supplier.id || snapshot.supplierCode !== supplier.code || snapshot.environment !== supplier.environment)) throw new Error('订单供应商连接或环境与创建时不一致');
      let result: TrackingResult;
      if (row.driverCode === 'FEDEX_RELAY') {
        const state = this.fedexConfig.status(supplier.code, true);
        if (!state.configured || state.environment.toUpperCase() !== supplier.environment) throw new Error('FedEx 原供应商 profile 未就绪或环境不匹配');
        const token = await this.fedex.getAccessToken(supplier.code);
        result = mapFedexTrack(await this.fedex.track(token.accessToken, [row.trackingNumber], supplier.code), [row.trackingNumber])[0]!;
      } else if (row.driverCode === 'UPS_OFFICIAL') {
        const profile = this.upsConfig.connection(supplier.code, supplier.environment);
        if (snapshot?.accountFingerprint && snapshot.accountFingerprint !== this.upsConfig.accountFingerprint(profile)) throw new Error('UPS 原寄件账号与创建时不一致');
        const token = await this.ups.getAccessToken(supplier.code, profile);
        try { result = mapUpsTrack((await this.ups.track(profile, token, row.trackingNumber)).body, row.trackingNumber); }
        catch (error) { if (error instanceof UpsRequestError && error.upstreamStatus === 404) result = mapUpsTrack({}, row.trackingNumber); else throw error; }
      } else throw new Error('当前供应商驱动未实现轨迹查询');
      const status = result.status === 'UNKNOWN' && !result.events.length ? 'LABEL_CREATED' : result.status;
      const nextMinutes = status === 'LABEL_CREATED' ? 120 : status === 'EXCEPTION' ? 120 : 60;
      await this.prisma.$transaction(async tx => {
        for (const event of result.events) {
          const eventKey = createHash('sha256').update(JSON.stringify([event.occurredAt.toISOString(), event.carrierStatusCode, event.description, event.city, event.state, event.countryCode])).digest('hex');
          await tx.shipmentTrackingEvent.upsert({ where: { trackingId_eventKey: { trackingId: id, eventKey } }, update: {}, create: { trackingId: id, eventKey, ...event } });
        }
        await tx.shipmentTracking.update({ where: { id }, data: { status, carrierStatusCode: result.carrierStatusCode, carrierDescription: result.carrierDescription, syncStatus: result.events.length ? 'READY' : 'NO_EVENTS', publicMessage: result.events.length ? null : '承运商暂未提供扫描记录', technicalError: null, lastSyncedAt: new Date(), nextSyncAt: TERMINAL.includes(status as TrackingStatus) ? null : new Date(Date.now() + nextMinutes * 60_000), claimedAt: null, failureCount: 0 } });
        await tx.connectorCallLog.create({ data: { orderId: row.orderId, driverCode: row.driverCode, operation: 'TRACK_SHIPMENT', status: 'SUCCESS', httpStatus: 200, requestPayload: { trackingNumber: row.trackingNumber }, responsePayload: { status, eventCount: result.events.length } } });
      });
    } catch (error) {
      const count = row.failureCount + 1; const delay = Math.min(24 * 60, 15 * 2 ** Math.min(count, 6));
      const technicalError = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500) : '未知轨迹查询错误';
      await this.prisma.shipmentTracking.update({ where: { id }, data: { syncStatus: 'ERROR', publicMessage: '轨迹暂时无法更新，已保留上次结果，系统稍后重试', technicalError, failureCount: count, claimedAt: null, nextSyncAt: new Date(Date.now() + delay * 60_000) } });
      await this.prisma.connectorCallLog.create({ data: { orderId: row.orderId, driverCode: row.driverCode, operation: 'TRACK_SHIPMENT', status: 'FAILED', httpStatus: error instanceof UpsRequestError ? error.upstreamStatus : null, requestPayload: { trackingNumber: row.trackingNumber }, errorMessage: technicalError } });
    }
  }
}
