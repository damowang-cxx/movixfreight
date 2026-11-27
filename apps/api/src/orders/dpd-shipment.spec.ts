import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { DpdRelayConfig, type DpdRelayProfile } from '../connectors/dpd-relay.config';
import { DpdRequestError } from '../connectors/dpd-relay.connector';
import { DpdShipmentService } from './dpd-shipment.service';

const profile: DpdRelayProfile = { enabled: true, environment: 'sandbox', baseUrl: 'http://example.test', userId: 'USER', password: 'SECRET', customerCode: 'C01', vendorName: 'DPD', serviceName: 'UK', shipper: { name: 'Test Ltd', contact: 'AVA', address1: 'Unit 2', city: 'London', postcode: 'UB78JD', telephone: '441234567890' } };
function harness(withPdf: boolean) {
  const config = new DpdRelayConfig({} as any); (config as any).profiles = () => ({ DPD_1: profile });
  const order: any = { id: 'order1', orderNo: 'ORD-1', shipmentStatus: 'SUBMITTED', feeStatus: 'PRECHARGED', recipientName: 'Recipient', recipientPhone: '447700900123', recipientCountryCode: 'GB', recipientCity: 'London', recipientPostcode: 'SW1A 1AA', recipientAddressLine1: 'High Street 1', recipientAddressLine2: null, recipientAddressLine3: null, currency: 'GBP', prechargedAmount: new Prisma.Decimal(10), service: { enabled: true, supplier: { id: 'supplier1', code: 'DPD_1', environment: 'SANDBOX', driverCode: 'DPD_RELAY_UK', enabled: true } }, boxes: [{ id: 'box1', weightKg: new Prisma.Decimal(1), lengthCm: new Prisma.Decimal(10), widthCm: new Prisma.Decimal(10), heightCm: new Prisma.Decimal(10), items: [{ englishName: 'Book', quantity: 1, unitDeclaredValue: new Prisma.Decimal(5), declaredValueCurrency: 'GBP' }] }] };
  order.supplierRouteSnapshot = { driverCode: 'DPD_RELAY_UK', supplierId: 'supplier1', supplierCode: 'DPD_1', environment: 'SANDBOX', accountFingerprint: config.accountFingerprint(profile), carrierServiceType: 'NDOC' };
  const audits: any[] = []; const labels: any[] = []; const refunds: any[] = []; let createCalls = 0;
  const db: any = {
    order: { findUnique: async () => order, updateMany: async ({ where, data }: any) => { if (order.shipmentStatus !== where.shipmentStatus) return { count: 0 }; Object.assign(order, data); return { count: 1 }; }, update: async ({ data }: any) => Object.assign(order, data) },
    orderBox: { update: async ({ data }: any) => Object.assign(order.boxes[0], data) },
    shipmentLabel: { create: async ({ data }: any) => labels.push(data) },
    cancellationRefundCase: { upsert: async ({ create }: any) => refunds.push(create) },
    shipmentDispatchJob: { updateMany: async () => ({ count: 1 }) },
    connectorCallLog: { create: async ({ data }: any) => audits.push(data) },
    $transaction: async (callback: any) => callback(db),
  };
  const pdf = Buffer.from('%PDF-1.4\n').toString('base64');
  const connector: any = { create: async () => { createCalls++; return { status: 200, body: { ResponseCode: 'RT01', Status: 'Success', ErrorCode: '0', AWBNo: 'AWB-1', RefNo: 'ORD-1', Pdfdownload: withPdf ? pdf : '' } }; }, print: async () => ({ status: 200, body: { ResponseCode: 'RT01', Status: 'Success', ErrorCode: '0', AWBNo: 'AWB-1', Pdfdownload: '' } }), cancel: async () => ({ status: 200, body: { Response: { Message: 'Success', StatusCode: '0' } } }) };
  const refundService: any = { assertRefundable: () => undefined, complete: async () => { refunds.push({ orderId: order.id, createdById: 'operator1' }); order.shipmentStatus = 'CANCELLED'; order.feeStatus = 'REFUNDED'; } };
  return { service: new DpdShipmentService(db, config, connector, refundService), connector, order, audits, labels, refunds, getCreateCalls: () => createCalls };
}

test('DPD creation stores one PDF and logs neither credentials nor label bytes', async () => {
  const h = harness(true);
  assert.equal((await h.service.create('order1')).labelCount, 1);
  assert.equal(h.order.shipmentStatus, 'GENERATED');
  assert.equal(h.order.carrierTrackingNumber, 'AWB-1');
  assert.equal(Buffer.from(h.labels[0].content).subarray(0, 4).toString(), '%PDF');
  assert.equal(JSON.stringify(h.audits).includes('SECRET'), false);
  assert.equal(JSON.stringify(h.audits).includes('JVBER'), false);
  assert.equal(h.audits[0].requestPayload.payload.Password, '[已脱敏]');
  assert.equal(h.audits[0].requestPayload.payload.ConsigneeName, 'Recipient');
  assert.equal(h.audits[0].requestPayload.payload.ProductCode, 'NDOC');
  assert.equal(h.audits[0].responsePayload.Pdfdownload, '[已省略附件内容]');
  await assert.rejects(h.service.create('order1'), /不能重复建单/);
  assert.equal(h.getCreateCalls(), 1);
});

test('DPD success without a usable label retains AWB for reprint and blocks duplicate creation', async () => {
  const h = harness(false);
  await assert.rejects(h.service.create('order1'), /没有可用 PDF/);
  assert.equal(h.order.shipmentStatus, 'UNKNOWN');
  assert.equal(h.order.carrierTrackingNumber, 'AWB-1');
  await assert.rejects(h.service.create('order1'), /不能重复建单/);
  assert.equal(h.getCreateCalls(), 1);
});

test('DPD unexpected HTTP 200 response is held for manual review with a redacted diagnostic summary', async () => {
  const h = harness(true);
  h.connector.create = async () => ({ status: 200, body: { Message: 'Unrecognized result', Password: profile.password } });
  await assert.rejects(h.service.create('order1'), /人工核查/);
  assert.equal(h.order.shipmentStatus, 'UNKNOWN');
  assert.equal(h.audits[0].responsePayload.Message, 'Unrecognized result');
  assert.equal(h.audits[0].responsePayload.Password, '[已脱敏]');
  assert.equal(JSON.stringify(h.audits).includes(profile.password), false);
  await assert.rejects(h.service.create('order1'), /不能重复建单/);
});

test('DPD explicit supplier error remains a confirmed failure', async () => {
  const h = harness(true);
  h.connector.create = async () => ({ status: 200, body: { ErrorCode: 'E1', APIError: 'Invalid product', errors: [{ field: 'ProductCode', message: 'Unknown code' }] } });
  await assert.rejects(h.service.create('order1'), /Invalid product/);
  assert.equal(h.order.shipmentStatus, 'FAILED');
  assert.equal(h.audits[0].responsePayload.APIError, 'Invalid product');
  assert.equal(h.audits[0].responsePayload.errors[0].field, 'ProductCode');
});

test('DPD nested validation errors are surfaced as confirmed rejection', async () => {
  const h = harness(true);
  h.connector.create = async () => ({ status: 200, body: { ResponseCode: 'TD01', ErrorCode: '1', Response: { Status: 'Fail', Error: [{ Description: 'Invalid Vendor Code/Name..!' }, { Description: 'Invalid Service Name..!' }] } } });
  await assert.rejects(h.service.create('order1'), /Invalid Vendor Code\/Name.*Invalid Service Name/);
  assert.equal(h.order.shipmentStatus, 'FAILED');
  assert.equal(h.audits[0].responsePayload.Response.Error[0].Description, 'Invalid Vendor Code/Name..!');
});

test('DPD HTTP error keeps the supplier response and HTTP code in the call log', async () => {
  const h = harness(true);
  h.connector.create = async () => { throw new DpdRequestError('CREATE', true, 422, 'HTTP_ERROR', '渠道返回 HTTP 422，需核查', { errors: [{ field: 'ServiceName', message: 'Unsupported' }] }); };
  await assert.rejects(h.service.create('order1'), /HTTP 422/);
  assert.equal(h.order.shipmentStatus, 'UNKNOWN');
  assert.equal(h.audits[0].httpStatus, 422);
  assert.equal(h.audits[0].responsePayload.errors[0].field, 'ServiceName');
});

test('DPD confirmed void completes refund with the cancellation', async () => {
  const h = harness(true);
  await h.service.create('order1');
  const result = await h.service.cancel('order1', 'operator1');
  assert.equal(result.supplierCancelled, true);
  assert.equal(h.order.shipmentStatus, 'CANCELLED');
  assert.equal(h.order.feeStatus, 'REFUNDED');
  assert.equal(h.order.prechargedAmount.toString(), '10');
  assert.equal(h.refunds.length, 1);
  assert.equal(h.refunds[0].createdById, 'operator1');
});
