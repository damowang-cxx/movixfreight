import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FedexRelayConnector } from '../connectors/fedex-relay.connector';
import { UpsOfficialConnector, UpsRequestError } from '../connectors/ups-official.connector';
import { mapFedexTrack, mapUpsTrack } from './tracking.mapper';
import { TrackingService } from './tracking.service';

test('FedEx scans normalize from master number and keep carrier descriptions', () => {
  const result = mapFedexTrack({ output: { completeTrackResults: [{ trackingNumber: '876123', trackResults: [{ trackingNumberInfo: { trackingNumber: '876123' }, latestStatusDetail: { code: 'DL', description: 'Delivered' }, scanEvents: [{ date: '2026-09-01T10:00:00+02:00', eventType: 'IT', eventDescription: 'In transit', scanLocation: { city: 'Paris', countryCode: 'FR' } }, { date: '2026-09-02T13:00:00+02:00', eventType: 'DL', eventDescription: 'Delivered', scanLocation: { city: 'Lyon', countryCode: 'FR' } }] }] }] } }, ['876123'])[0];
  assert.equal(result.status, 'DELIVERED');
  assert.equal(result.events[0]?.occurredAt.toISOString(), '2026-09-01T08:00:00.000Z');
  assert.equal(result.events[1]?.status, 'DELIVERED');
  assert.equal(mapFedexTrack({ output: { completeTrackResults: [] } }, ['NEW'])[0]?.status, 'LABEL_CREATED');
});

test('UPS two-piece response selects the requested box, UTC scan and delivered status', () => {
  const response = { trackResponse: { shipment: [{ package: [
    { trackingNumber: '1ZFIRST', currentStatus: { type: 'I' }, activity: [] },
    { trackingNumber: '1ZSECOND', currentStatus: { type: 'D', description: 'Delivered' }, activity: [{ gmtDate: '20260902', gmtTime: '74700', status: { type: 'D', code: '011', description: 'Delivered' }, location: { address: { city: 'Brussels', countryCode: 'BE' } } }] },
  ] }] } };
  const result = mapUpsTrack(response, '1ZSECOND');
  assert.equal(result.status, 'DELIVERED');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.occurredAt.toISOString(), '2026-09-02T07:47:00.000Z');
  assert.equal(result.events[0]?.city, 'Brussels');
  assert.equal(mapUpsTrack(response, 'MISSING').events.length, 0);
});

test('track connectors call read-only endpoints and do not request proof-of-delivery images', async () => {
  const original = globalThis.fetch; const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ trackResponse: { shipment: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const fedex = new FedexRelayConnector({ assertReady: () => {}, connection: () => ({ baseUrl: 'https://direct.ship-api.com/fedex', authHeaderName: 'ship-api-authorization', shipApiKey: 'secret' }) } as any);
    await fedex.track('token', ['876123'], 'FEDEX1');
    const ups = new UpsOfficialConnector();
    await ups.track({ environment: 'production' } as any, 'token', '1ZABC');
    assert.equal(calls[0]?.url, 'https://direct.ship-api.com/fedex/track/v1/trackingnumbers');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)).trackingInfo, [{ trackingNumberInfo: { trackingNumber: '876123' } }]);
    assert.equal(calls[1]?.url, 'https://onlinetools.ups.com/api/track/v1/details/1ZABC?locale=en_US&returnSignature=false&returnPOD=false');
    assert.equal(calls[1]?.init.method, 'GET');
  } finally { globalThis.fetch = original; }
});

test('UPS unscanned 404 without JSON keeps its HTTP status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('No tracking information', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  try {
    await assert.rejects(new UpsOfficialConnector().track({ environment: 'production' } as any, 'token', '1ZNEW'), (error: any) => error instanceof UpsRequestError && error.upstreamStatus === 404);
  } finally { globalThis.fetch = original; }
});

test('admin refresh uses an atomic cooldown condition', async () => {
  let refreshed = false;
  const db: any = {
    order: { findUnique: async () => ({ id: 'order1', shipmentStatus: 'GENERATED', trackingRecords: [{ id: 'track1', refreshRequestedAt: null }] }) },
    shipmentTracking: {
      findMany: async () => [{ id: 'track1', refreshRequestedAt: refreshed ? new Date() : null }],
      count: async () => 1,
      updateMany: async ({ where }: any) => {
        assert.ok(where.OR?.some((condition: any) => condition.refreshRequestedAt === null));
        if (refreshed) return { count: 0 };
        refreshed = true; return { count: 1 };
      },
    },
  };
  const service = new TrackingService(db, {} as any, {} as any, {} as any, {} as any);
  assert.equal((await service.requestRefresh('order1')).queued, true);
  await assert.rejects(service.requestRefresh('order1'), /5 分钟/);
});

test('customer tracking lookup is scoped by customer and an untracked order has an empty timeline', async () => {
  const prisma: any = { order: { findFirst: async ({ where }: any) => where.customerId === 'owner' ? { id: 'id1', orderNo: 'ORD-1', shipmentStatus: 'SUBMITTED', carrierTrackingNumber: null, boxes: [], trackingRecords: [] } : null }, shipmentTracking: { findMany: async () => [] } };
  const service = new TrackingService(prisma, {} as any, {} as any, {} as any, {} as any);
  const owned = await service.detail('ORD-1', 'owner', true);
  assert.equal(owned.shipment_id, 'ORD-1'); assert.deepEqual(owned.packages, []);
  await assert.rejects(service.detail('ORD-1', 'other', true), /无权访问/);
});

test('successful polling stores scans once, preserves order status and stops delivered scans', async () => {
  const row: any = { id: 'track1', orderId: 'order1', trackingNumber: '876123', driverCode: 'FEDEX_RELAY', nextSyncAt: new Date(0), failureCount: 0, order: { shipmentStatus: 'GENERATED', supplierRouteSnapshot: { driverCode: 'FEDEX_RELAY', supplierId: 'supplier1', supplierCode: 'FEDEX1', environment: 'PRODUCTION' }, service: { supplier: { id: 'supplier1', code: 'FEDEX1', driverCode: 'FEDEX_RELAY', environment: 'PRODUCTION' } } } };
  const events = new Map<string, any>(); const logs: any[] = []; let calls = 0;
  const db: any = {
    shipmentTracking: {
      findMany: async () => row.nextSyncAt && row.nextSyncAt <= new Date() && row.order.shipmentStatus !== 'CANCELLED' ? [{ id: row.id }] : [],
      updateMany: async ({ data }: any) => { Object.assign(row, data); return { count: 1 }; },
      findUniqueOrThrow: async () => row,
      update: async ({ data }: any) => Object.assign(row, data),
    },
    shipmentTrackingEvent: { upsert: async ({ where, create }: any) => events.set(where.trackingId_eventKey.eventKey, create) },
    connectorCallLog: { create: async ({ data }: any) => logs.push(data) },
    $transaction: async (callback: any) => callback(db),
  };
  const fedex: any = { getAccessToken: async () => ({ accessToken: 'token' }), track: async () => { calls++; return { output: { completeTrackResults: [{ trackingNumber: '876123', trackResults: [{ trackingNumberInfo: { trackingNumber: '876123' }, latestStatusDetail: { code: 'DL', description: 'Delivered' }, scanEvents: [{ date: '2026-09-02T10:00:00Z', eventType: 'DL', eventDescription: 'Delivered' }, { date: '2026-09-02T10:00:00Z', eventType: 'DL', eventDescription: 'Delivered' }] }] }] } }; } };
  const service = new TrackingService(db, { status: () => ({ configured: true, environment: 'production' }) } as any, fedex, {} as any, {} as any);
  await service.syncDue(); await service.syncDue();
  assert.equal(calls, 1); assert.equal(row.status, 'DELIVERED'); assert.equal(row.nextSyncAt, null);
  assert.equal(events.size, 1); assert.equal(row.order.shipmentStatus, 'GENERATED'); assert.equal(logs[0]?.operation, 'TRACK_SHIPMENT');
});

test('polling error retains last successful status, then cancellation suppresses polling', async () => {
  const row: any = { id: 'track1', orderId: 'order1', trackingNumber: '876123', driverCode: 'FEDEX_RELAY', status: 'IN_TRANSIT', nextSyncAt: new Date(0), failureCount: 0, order: { shipmentStatus: 'GENERATED', supplierRouteSnapshot: null, service: { supplier: { id: 'supplier1', code: 'FEDEX1', driverCode: 'FEDEX_RELAY', environment: 'PRODUCTION' } } } };
  const db: any = { shipmentTracking: { findMany: async () => row.order.shipmentStatus === 'CANCELLED' ? [] : [{ id: row.id }], updateMany: async ({ data }: any) => { Object.assign(row, data); return { count: 1 }; }, findUniqueOrThrow: async () => row, update: async ({ data }: any) => Object.assign(row, data) }, connectorCallLog: { create: async () => {} } };
  let calls = 0;
  const service = new TrackingService(db, { status: () => ({ configured: true, environment: 'production' }) } as any, { getAccessToken: async () => ({ accessToken: 'token' }), track: async () => { calls++; throw new Error('temporary upstream failure'); } } as any, {} as any, {} as any);
  await service.syncDue();
  assert.equal(row.status, 'IN_TRANSIT'); assert.equal(row.syncStatus, 'ERROR'); assert.ok(row.nextSyncAt > new Date());
  row.order.shipmentStatus = 'CANCELLED'; await service.syncDue(); assert.equal(calls, 1);
});
