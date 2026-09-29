import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
const sharp: typeof import('sharp').default = require('sharp');
import { profile, upsOrder } from '../../test/ups-fixtures';
import { UpsOfficialConfig } from '../connectors/ups-official.config';
import { UpsRequestError } from '../connectors/ups-official.connector';
import { UpsLabelService } from './ups-label.service';
import { UpsShipmentService, parseUpsShipment, upsVoidConfirmed } from './ups-shipment.service';
import { OrdersService } from './orders.service';

const tracking = ['1ZABC1230000000001', '1ZABC1230000000002'];
const response = (image = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==') => ({ ShipmentResponse: { Response: { ResponseStatus: { Code: '1' } }, ShipmentResults: { ShipmentIdentificationNumber: tracking[0], PackageResults: tracking.map(TrackingNumber => ({ TrackingNumber, ShippingLabel: { GraphicImage: image } })) } } });
function harness() {
  const order: any = upsOrder(); const saved: any[] = []; const audit: any[] = []; const refunds = new Set(); let createCalls = 0; let cancelCalls = 0;
  const job: any = { orderId: order.id, status: 'PROCESSING' };
  const db: any = {
    order: { findUnique: async () => structuredClone(order), updateMany: async ({ where, data }: any) => { if (where.shipmentStatus && order.shipmentStatus !== where.shipmentStatus) return { count: 0 }; Object.assign(order, data); return { count: 1 }; }, update: async ({ data }: any) => Object.assign(order, data) },
    orderBox: { update: async ({ where, data }: any) => Object.assign(order.boxes.find((b: any) => b.id === where.id), data) },
    shipmentLabel: { create: async ({ data }: any) => { const label = { ...data, id: `label${saved.length}` }; saved.push(label); return label; }, findMany: async () => saved, update: async ({ where, data }: any) => Object.assign(saved.find(l => l.id === where.id), data), count: async () => saved.filter(l => l.contentType !== 'application/pdf').length },
    shipmentDispatchJob: { updateMany: async ({ data }: any) => Object.assign(job, data) },
    cancellationRefundCase: { upsert: async ({ create }: any) => refunds.add(create.orderId) },
    connectorCallLog: { create: async ({ data }: any) => audit.push(data) },
    $transaction: async (cb: any) => cb(db),
  };
  const config = new UpsOfficialConfig({} as any); (config as any).profiles = () => ({ UPS1: profile });
  const connector: any = { getAccessToken: async () => 'token', create: async () => { createCalls++; return { body: response(), status: 200, transactionId: 'tx' }; }, cancel: async () => { cancelCalls++; return { body: { VoidShipmentResponse: { Response: { ResponseStatus: { Code: '1' } }, SummaryResult: { Status: { Code: '1' } } } }, status: 200, transactionId: 'cancel' }; } };
  const labels = new UpsLabelService(db);
  const service = new UpsShipmentService(db, config, connector, labels);
  return { order, saved, audit, refunds, connector, labels, service, config, db, job, calls: () => ({ createCalls, cancelCalls }) };
}
test('UPS GIF conversion emits actual 4x6 PDF with original pixel image and no FedEx crop', async () => {
  const labels = new UpsLabelService({} as any);
  const gif = await sharp({ create: { width: 800, height: 1200, channels: 3, background: 'white' } }).gif().toBuffer();
  const pdf = await PDFDocument.load(await labels.toPdf(gif));
  assert.equal(pdf.getPages().length, 1); assert.deepEqual(pdf.getPage(0).getSize(), { width: 288, height: 432 });
  await assert.rejects(labels.toPdf(Buffer.from('invalid')));
});
test('UPS creation locks atomically, saves ordered box tracking/originals once, duplicate create refused', async () => {
  const h = harness(); h.order.boxes.reverse();
  const results = await Promise.allSettled([h.service.create('order1'), h.service.create('order1')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(h.calls().createCalls, 1);
  assert.deepEqual(h.saved.map(l => l.boxId), ['box0', 'box1']); assert.deepEqual(h.saved.map(l => l.trackingNumber), tracking);
  assert.ok(h.saved.every(l => l.sourceContent && l.contentType === 'application/pdf'));
  assert.equal(h.order.shipmentStatus, 'GENERATED');
  assert.equal(JSON.stringify(h.audit).includes(profile.shipperNumber), false); assert.equal(JSON.stringify(h.audit).includes('R0lG'), false);
});
test('PDF failure retains generated shipment and originals; repair is local only', async () => {
  const h = harness(); const convert = h.labels.toPdf.bind(h.labels); h.labels.toPdf = async () => { throw new Error('conversion'); };
  await assert.rejects(h.service.create('order1'), /PDF 处理失败/);
  assert.equal(h.order.shipmentStatus, 'GENERATED'); assert.equal(h.saved.length, 2); assert.ok(h.saved.every(l => l.sourceContent));
  const summary = new OrdersService({} as any, {} as any, {} as any, {} as any).dispatchSummary({ shipmentStatus: h.order.shipmentStatus, labels: h.saved, dispatchJob: h.job }, false);
  assert.equal(summary.reasonCode, 'LABEL_PROCESSING_FAILED');
  h.labels.toPdf = convert; for (const label of h.saved) await h.labels.ensure(label);
  assert.equal(h.calls().createCalls, 1); assert.equal(h.job.status, 'COMPLETED');
});
test('unknown create never retries; credential failure never sends Shipping', async () => {
  const h = harness(); h.connector.create = async () => { throw new UpsRequestError('CREATE', true, null, 'tx', 'UNKNOWN', 'timeout'); };
  await assert.rejects(h.service.create('order1')); assert.equal(h.order.shipmentStatus, 'UNKNOWN'); await assert.rejects(h.service.create('order1'), /不能重复/);
  const h2 = harness(); h2.connector.getAccessToken = async () => { throw new UpsRequestError('OAUTH', false, 401, 'tx', 'AUTH', 'denied'); };
  await assert.rejects(h2.service.create('order1')); assert.equal(h2.calls().createCalls, 0); assert.equal(h2.audit[0].requestPayload.shippingRequestSent, false);
});
test('whole-shipment cancellation is explicit and creates one finance task without wallet change', async () => {
  const h = harness(); await h.service.create('order1');
  const result = await h.service.cancel('order1', 'admin'); assert.equal(result.cancelled, true); assert.equal(h.order.shipmentStatus, 'CANCELLED'); assert.equal(h.refunds.size, 1);
  await assert.rejects(h.service.cancel('order1'), /不可取消/); assert.equal(h.calls().cancelCalls, 1); assert.equal(h.refunds.size, 1);
});
test('partial/unknown cancellation is not success and never creates refund; modified environment blocked', async () => {
  const h = harness(); await h.service.create('order1'); h.connector.cancel = async () => ({ body: { VoidShipmentResponse: { Response: { ResponseStatus: { Code: '1' } } } }, status: 200 });
  await assert.rejects(h.service.cancel('order1')); assert.equal(h.order.shipmentStatus, 'UNKNOWN'); assert.equal(h.refunds.size, 0);
  const h2 = harness(); h2.order.service.supplier.environment = 'SANDBOX'; await assert.rejects(h2.service.create('order1'), /环境已改变/);
  assert.equal(upsVoidConfirmed({ VoidShipmentResponse: { Response: { ResponseStatus: { Code: '1' } }, SummaryResult: { Status: { Code: '1' } }, PackageLevelResults: [{ TrackingNumber: tracking[0], Status: { Code: '1' } }] } }, tracking), false);
  assert.throws(() => parseUpsShipment({}, 1), /缺少/);
});

test('Belgian origin survives queued creation; changed origin blocks Shipping but not cancellation of an existing label', async () => {
  const belgian = { ...profile, shipper: { ...profile.shipper, countryCode: 'BE', city: 'TERNAT', postalCode: '1740', stateCode: '' } };
  const h = harness();
  (h.config as any).profiles = () => ({ UPS1: belgian });
  h.order.supplierRouteSnapshot.shipperCountryCode = 'BE';
  const create = h.connector.create;
  h.connector.create = async (_p: any, _token: any, body: any) => {
    assert.equal(body.ShipmentRequest.Shipment.ShipFrom.Address.CountryCode, 'BE');
    assert.equal(body.ShipmentRequest.Shipment.Shipper.Address.CountryCode, 'BE');
    return create();
  };
  await h.service.create('order1');
  assert.equal(h.order.shipmentStatus, 'GENERATED');
  assert.equal(h.calls().createCalls, 1);
  const legacy = harness();
  (legacy.config as any).profiles = () => ({ UPS1: belgian });
  await assert.rejects(legacy.service.create('order1'), /发件国与订单创建时不一致/);
  assert.equal(legacy.calls().createCalls, 0);
  const generated = harness(); await generated.service.create('order1');
  (generated.config as any).profiles = () => ({ UPS1: belgian });
  await generated.service.cancel('order1');
  assert.equal(generated.order.shipmentStatus, 'CANCELLED');
});
