import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { ShipmentOperationsService } from './shipment-operations.service';
import { OrdersService } from './orders.service';
import { ProductsService } from '../products/products.service';
import { ShipmentDispatchQueueService } from '../open-api/shipment-dispatch-queue.service';
import { OpenApiShipmentsService } from '../open-api/open-api-shipments.service';
import { UpsOfficialConfig } from '../connectors/ups-official.config';
import { profile, upsOrder } from '../../test/ups-fixtures';
import { routeFieldSchema } from '../connectors/connector-drivers.registry';

function orderHarness() {
  const wallet = { id: 'wallet1', currency: 'EUR', balance: new Prisma.Decimal(100) }; let saved: any; const ledgers: any[] = []; let enqueues = 0; let quotes = 0;
  const pricing: any = { resolveDestinationCountry: async (v: string) => v === '荷兰' ? 'NL' : v.toUpperCase(), quote: async () => { quotes++; return { total: '10', currency: 'EUR' }; } };
  const resolved: any = { shipperCountryCode: 'BE', accountFingerprint: 'hash', supplier: { id: 'supplier1', code: 'UPS1', driverCode: 'UPS_OFFICIAL', environment: 'PRODUCTION' }, service: { id: 'service1', code: 'UPS_STANDARD', minPieces: 1, allowsMultiPiece: true, measurementMethod: 'PER_BOX' }, route: { id: 'route1', code: 'STANDARD', routeType: 'DEFAULT', carrierServiceType: '11', fieldSchema: routeFieldSchema('UPS_OFFICIAL', 'NONE', {}) } };
  const products: any = { resolveOrderRoute: async (_id: string, country: string, allowSandbox: boolean) => { if (country !== 'NL' || resolved.supplier.environment === 'SANDBOX' && !allowSandbox) throw new Error('无可用路由'); return resolved; } };
  const db: any = { order: { findUnique: async () => saved ?? null, create: async ({ data }: any) => saved = { id: 'order1', ...data } }, customer: { findUnique: async () => ({ id: 'customer1', status: 'NORMAL', wallets: [wallet] }) }, customerWallet: { update: async ({ data }: any) => Object.assign(wallet, data) }, walletLedger: { create: async ({ data }: any) => ledgers.push(data) }, $transaction: async (cb: any, options: any) => { assert.equal(options.isolationLevel, 'Serializable'); return cb(db); } };
  const svc = new OrdersService(db, pricing, { evaluateInTransaction: async () => {} } as any, { requiredDeclarationFields: async () => [] } as any, products, { enqueue: async () => { enqueues++; } } as any);
  const o = upsOrder(); const input: any = { supplierId: 'supplier1', idempotencyKey: 'key1', recipientName: o.recipientName, recipientPhone: o.recipientPhone, recipientCountryCode: '荷兰', recipientCity: o.recipientCity, recipientPostcode: o.recipientPostcode, recipientAddress: 'ABCDEFGHIJKLMNOPQRSTUVW 12', estimatedChargeableKg: '2', boxes: o.boxes.map(({ id, ...box }) => ({ ...box, boxNo: undefined })) };
  return { svc, db, products, input, wallet, ledgers, resolved, saved: () => saved, counts: () => ({ enqueues, quotes }) };
}
test('admin, portal and Excel use same UPS preflight, normalized address, precharge and one durable task', async () => {
  for (const entry of ['admin', 'portal', 'excel']) {
    const h = orderHarness();
    if (entry === 'admin') await h.svc.createForAdmin('customer1', h.input);
    if (entry === 'portal') await h.svc.createForCustomer('customer1', h.input);
    if (entry === 'excel') { const preview = await h.svc.previewImportForAdmin([{ rowNo: 1, customerId: 'customer1', order: h.input }]); assert.equal(preview[0].status, 'READY'); await h.svc.importForAdmin('fixture.xlsx', [{ rowNo: 1, customerId: 'customer1', order: h.input }]); }
    assert.equal(h.wallet.balance.toString(), '90'); assert.equal(h.ledgers.length, 1); assert.equal(h.saved().dispatchJob.create.status, 'PENDING');
    assert.equal(h.saved().supplierRouteSnapshot.shipperCountryCode, 'BE');
    assert.equal(h.saved().recipientAddressLine1, 'ABCDEFGHIJKLMNOPQRSTUVW 12'); assert.equal(h.saved().recipientCountryCode, 'NL');
    assert.equal(h.saved().supplierRouteSnapshot.packageOrder.length, 2); assert.ok(h.saved().boxes.create[0].boxNo.startsWith('ORD-'));
    assert.equal(h.counts().enqueues, 1);
  }
});
test('idempotent order re-submit does not debit again; unsupported field/address, route and balance failures do not create', async () => {
  const h = orderHarness(); const first = await h.svc.createForCustomer('customer1', h.input); const second = await h.svc.createForCustomer('customer1', h.input); assert.equal(first.id, second.id); assert.equal(h.ledgers.length, 1); assert.equal(h.counts().quotes, 1);
  for (const patch of [{ recipientCountryCode: 'GB' }, { deliveryWith: 'ddp' }, { recipientAddress: 'X'.repeat(36) }]) { const bad = orderHarness(); await assert.rejects(bad.svc.createForAdmin('customer1', { ...bad.input, ...patch })); assert.equal(bad.saved(), undefined); assert.equal(bad.ledgers.length, 0); assert.equal(bad.counts().quotes, 0); }
  const low = orderHarness(); low.wallet.balance = new Prisma.Decimal(9); await assert.rejects(low.svc.createForAdmin('customer1', low.input), /余额不足/); assert.equal(low.ledgers.length, 0); assert.equal(low.saved(), undefined);
  const sandbox = orderHarness(); sandbox.resolved.supplier.environment = 'SANDBOX'; await assert.rejects(sandbox.svc.createForCustomer('customer1', sandbox.input), /无可用路由/); await sandbox.svc.createForAdmin('customer1', sandbox.input);
});
test('UPS country routes require exact configured profile, enabled service, unique route, EU destinations and fixed code 11', async () => {
  const order = upsOrder(); const supplier: any = { ...order.service.supplier, carrier: {}, services: [], countryRoutes: [{ id: 'route1', serviceId: 's1', carrierServiceType: '11', customsMode: 'NONE', fieldConfig: {}, countries: [{ countryCode: 'NL' }], service: { id: 's1', enabled: true, supplierId: 'supplier1' } }] };
  const config = new UpsOfficialConfig({} as any); (config as any).profiles = () => ({ UPS1: profile });
  const db: any = { country: { findFirst: async () => ({ code: 'NL' }) }, supplier: { findFirst: async () => supplier } };
  const products = new ProductsService(db, {} as any, config);
  assert.equal((await products.resolveOrderRoute('supplier1', '荷兰', true)).route.carrierServiceType, '11');
  assert.equal((await products.resolveOrderRoute('supplier1', '荷兰', true)).shipperCountryCode, 'NL');
  (config as any).profiles = () => ({ UPS1: { ...profile, shipper: { ...profile.shipper, countryCode: 'BE', postalCode: '1740', city: 'TERNAT', stateCode: '' } } });
  assert.equal((await products.resolveOrderRoute('supplier1', '荷兰', true)).shipperCountryCode, 'BE');
  supplier.countryRoutes[0].service.enabled = false; await assert.rejects(products.resolveOrderRoute('supplier1', '荷兰', true), /停用/); supplier.countryRoutes[0].service.enabled = true;
  supplier.countryRoutes.push(supplier.countryRoutes[0]); await assert.rejects(products.resolveOrderRoute('supplier1', '荷兰', true), /多个/); supplier.countryRoutes.pop();
  supplier.countryRoutes[0].carrierServiceType = '07'; await assert.rejects(products.resolveOrderRoute('supplier1', '荷兰', true), /Standard/); supplier.countryRoutes[0].carrierServiceType = '11';
  supplier.code = 'MISSING'; await assert.rejects(products.resolveOrderRoute('supplier1', '荷兰', true), /未就绪/);
});
test('durable queue claim prevents duplicate carrier creation, including redelivery after restart', async () => {
  const job: any = { status: 'PENDING', stage: 'QUEUED' }; let executed = 0;
  const db: any = { shipmentDispatchJob: { updateMany: async ({ where, data }: any) => { if (where.status !== job.status) return { count: 0 }; Object.assign(job, data); return { count: 1 }; }, update: async ({ data }: any) => Object.assign(job, data) } };
  const operations: any = { create: async (_id: string, stage: any) => { executed++; await stage('CREATING'); } };
  const queue = new ShipmentDispatchQueueService({ get: () => undefined } as any, db, operations);
  await Promise.all([(queue as any).process('order1'), (queue as any).process('order1')]);
  const restarted = new ShipmentDispatchQueueService({ get: () => undefined } as any, db, operations); await (restarted as any).process('order1');
  assert.equal(executed, 1); assert.equal(job.status, 'COMPLETED');
});
test('Open API leaves long addresses for driver-specific splitting and downloads only owner box labels', async () => {
  let created: any; let owned = true;
  const labels = [{ id: 'label1', box: { boxNo: 'BOX1' }, trackingNumber: 'tracking1', content: Buffer.from('%PDF'), contentType: 'application/pdf', sourceContent: null }, { id: 'label2', box: { boxNo: 'BOX2' }, trackingNumber: 'tracking2', content: Buffer.from('%PDF'), contentType: 'application/pdf', sourceContent: null }];
  const db: any = { supplier: { findUnique: async () => ({ id: 'supplier1' }) }, openApiIdempotencyRecord: { findUnique: async () => null, create: async () => ({}) }, order: { findUniqueOrThrow: async () => ({ orderNo: 'ORD-1', clientReference: null }), findFirst: async ({ where }: any) => { assert.equal(where.customerId, 'customer1'); return owned ? { orderNo: 'ORD-1', carrierTrackingNumber: 'tracking1', shipmentStatus: 'GENERATED', labels, dispatchJob: null } : null; } }, $transaction: async () => {} };
  const orders: any = { createForCustomer: async (_c: string, input: any) => { created = input; return { id: 'order1' }; }, dispatchSummary: () => ({ status: 'READY' }) };
  const open = new OpenApiShipmentsService(db, orders, { resolveDestinationCountry: async () => 'NL' } as any, { ensure: async (label: any) => label } as any);
  const customer: any = { customerId: 'customer1' };
  await open.create(customer, 'external-key', { shipment: { supplier: 'UPS1', parcel_count: 1, declaration_currency: 'EUR', to_address: { name: 'Recipient', city: 'Amsterdam', country: '荷兰', postcode: '1012JS', tel: '+31201234567', address_1: 'ABCDEFGHIJKLMNOPQRSTUVW', address_2: ' 12' }, parcels: [{ client_weight: 1, client_length: 20, client_width: 10, client_height: 10, declarations: [{ name_en: 'Phone case' }] }] } } as any);
  assert.equal(created.recipientAddress, 'ABCDEFGHIJKLMNOPQRSTUVW 12'); assert.equal(created.supplierId, 'supplier1');
  const result = await open.label(customer, 'ORD-1'); assert.equal(result.shipment.labels[1].box_no, 'BOX2');
  await assert.rejects(open.labelFile(customer, 'ORD-1'), /多个面单/); assert.equal((await open.labelFile(customer, 'ORD-1', 'label2')).id, 'label2');
  owned = false; await assert.rejects(open.labelFile(customer, 'ORD-1', 'label1'), /无权访问/);
});
test('Open API request hash is saved inside the precharge transaction and rejects changed replays', async () => {
  const h = orderHarness(); let record: any; let inTransaction = false;
  h.db.openApiIdempotencyRecord = {
    findUnique: async () => record,
    create: async ({ data }: any) => { assert.equal(inTransaction, true); assert.equal(h.ledgers.length, 0); record = data; return data; },
  };
  const transaction = h.db.$transaction;
  h.db.$transaction = async (...args: any[]) => { inTransaction = true; try { return await transaction(...args); } finally { inTransaction = false; } };
  const options = { openRequest: { idempotencyKeyHash: 'keyhash', requestHash: 'bodyhash' } };
  const first = await h.svc.createForCustomer('customer1', h.input, options);
  assert.equal(record.orderId, first.id);
  assert.equal((await h.svc.createForCustomer('customer1', h.input, options)).id, first.id);
  await assert.rejects(h.svc.createForCustomer('customer1', { ...h.input, recipientName: 'Different' }, { openRequest: { ...options.openRequest, requestHash: 'different' } }), /Idempotency-Key/);
  assert.equal(h.ledgers.length, 1);
});

test('generic executor retains FedEx legacy create/cancel and blocks changed snapshots and unsupported drivers', async () => {
  let supplier: any = { id: 's1', code: 'FEDEX1', driverCode: 'FEDEX_RELAY', environment: 'SANDBOX' };
  let snapshot: any = null; const calls: string[] = [];
  const fedex: any = { create: async () => calls.push('fedex-create'), cancel: async () => calls.push('fedex-cancel') };
  const ups: any = { create: async () => calls.push('ups-create'), cancel: async () => calls.push('ups-cancel') };
  const operations = new ShipmentOperationsService({ order: { findUnique: async () => ({ service: { supplier }, supplierRouteSnapshot: snapshot }) } } as any, fedex, ups);
  await operations.create('legacy'); await operations.cancel('legacy');
  supplier = { ...supplier, code: 'UPS1', driverCode: 'UPS_OFFICIAL', environment: 'PRODUCTION' };
  snapshot = { driverCode: 'UPS_OFFICIAL', supplierId: 's1', supplierCode: 'UPS1', environment: 'PRODUCTION' };
  await operations.create('ups'); await operations.cancel('ups');
  supplier.environment = 'SANDBOX'; await assert.rejects(operations.create('ups'), /错环境/);
  supplier.driverCode = 'UNSUPPORTED'; snapshot = null; await assert.rejects(operations.create('new'), /尚不支持/);
  assert.deepEqual(calls, ['fedex-create', 'fedex-cancel', 'ups-create', 'ups-cancel']);
});
