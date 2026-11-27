import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { DpdRelayConfig, type DpdRelayProfile } from './dpd-relay.config';
import { DpdRelayConnector, DpdRequestError } from './dpd-relay.connector';
import { buildDpdShipment, dpdPdf, dpdRejection, dpdSuccess } from './dpd-relay.mapper';
import { dpdTrackingStatus, mapDpdTrack } from './dpd-relay.tracking';
import { getConnectorDriver, routeFieldSchema } from './connector-drivers.registry';
import { normalizeRecipientAddress } from '../orders/recipient-address';

const profile: DpdRelayProfile = {
  enabled: true, environment: 'production', baseUrl: 'https://example.test', userId: 'test-user', password: 'test-password', customerCode: 'C01',
  vendorName: 'DPD', serviceName: 'UK DOMESTIC',
  shipper: { name: 'Test Sender Ltd', contact: 'AVA', address1: 'Unit 2 horton instrial park', address2: 'horton road', city: 'west drayton', state: 'London', postcode: 'UB78JD', telephone: '441234567890', email: 'Ava@epix-logistics.com' },
};
const order: any = {
  orderNo: 'ORD-TEST-1', recipientCountryCode: 'GB', recipientName: 'Test Recipient', recipientPhone: '447700900123', recipientAddressLine1: 'High Street 1', recipientAddressLine2: null, recipientAddressLine3: null, recipientCity: 'London', recipientState: 'London', recipientPostcode: 'SW1A 1AA',
  supplierRouteSnapshot: { carrierServiceType: 'NDOC' },
  boxes: [{ weightKg: new Prisma.Decimal('1.5'), lengthCm: new Prisma.Decimal(20), widthCm: new Prisma.Decimal(15), heightCm: new Prisma.Decimal(10), items: [{ englishName: 'Books', harmonizedCode: '4901', quantity: 2, unitDeclaredValue: new Prisma.Decimal('5.50'), declaredValueCurrency: 'GBP', itemWeightKg: new Prisma.Decimal('0.5') }] }],
};

test('DPD UK driver rejects an incomplete shipper and HTTP production profile before precharge', () => {
  const config = new DpdRelayConfig({} as any);
  (config as any).profiles = () => ({ DPD_1: { ...profile, baseUrl: 'http://example.test', shipper: { ...profile.shipper, telephone: '44' } } });
  assert.equal(config.status('DPD_1').configured, false);
  assert.ok(config.status('DPD_1').missing.includes('shipper.telephone 需要完整号码'));
  (config as any).profiles = () => ({ DPD_1: { ...profile, ukDomesticConfirmed: true } });
  assert.equal(config.status('DPD_1').configured, true);
  (config as any).profiles = () => ({ DPD_1: { ...profile, ukDomesticConfirmed: true, shipper: { ...profile.shipper, name: 'A'.repeat(31) } } });
  assert.equal(config.status('DPD_1').configured, false);
  assert.equal(config.status('MISSING').configured, false);
  assert.equal(getConnectorDriver('DPD_RELAY_UK')?.carrierCodes[0], 'DPD');
  assert.deepEqual(routeFieldSchema('DPD_RELAY_UK', 'NONE', {}).declarationRequired, ['englishName', 'quantity', 'unitDeclaredValue', 'declaredValueCurrency']);
});

test('DPD mapper sends a single domestic parcel with declared goods value and two address lines', () => {
  assert.equal(normalizeRecipientAddress(['High Street 1'], 'DPD_RELAY_UK').line1, 'High Street 1');
  const payload = buildDpdShipment(order, profile);
  assert.equal(payload.ShipmentValue, '11.00');
  assert.equal(payload.ProductCode, 'NDOC');
  assert.equal(payload.OriginName, profile.shipper.name);
  assert.equal(payload.DestinationName, order.recipientName);
  assert.equal(payload.ConsigneeAdd1, order.recipientAddressLine1);
  assert.equal(payload.Currency, 'GBP');
  assert.equal(payload.Dimensions[0]?.ActualWeight, '1.500');
  assert.equal(payload.ShipperContact, 'AVA');
  assert.equal(payload.ConsigneePin, 'SW1A 1AA');
  assert.throws(() => buildDpdShipment({ ...order, boxes: [order.boxes[0], order.boxes[0]] }, profile), /一票一件/);
  assert.throws(() => buildDpdShipment({ ...order, recipientName: 'A'.repeat(31) }, profile), /DestinationName/);
  assert.throws(() => normalizeRecipientAddress(['A'.repeat(61)], 'DPD_RELAY_UK'), /超过 30/);
});

test('DPD responses require a real PDF and tracking events retain UK local time', () => {
  assert.equal(dpdSuccess({ ResponseCode: 'RT01', ErrorCode: '0', Status: 'Success' }), true);
  assert.deepEqual(dpdRejection({ ResponseCode: 'TD01', ErrorCode: '1', Response: { Status: 'Fail', Error: [{ Description: 'Invalid Vendor Code/Name..!' }, { Description: 'Invalid Service Name..!' }, { Description: 'Destination Cannot be Empty..!' }] } }), { explicit: true, messages: ['Invalid Vendor Code/Name..!', 'Invalid Service Name..!', 'Destination Cannot be Empty..!'] });
  assert.equal(dpdPdf({ Pdfdownload: Buffer.from('%PDF-1.4\n').toString('base64') })?.subarray(0, 4).toString(), '%PDF');
  assert.equal(dpdPdf({ Pdfdownload: Buffer.from('not a pdf').toString('base64') }), null);
  const track = mapDpdTrack({ ErrorCode: '0', Tracking: [{ AWBNo: '123', Status: 'SHIPMENT RECEIVED' }, { EventDate: '03/03/2023', EventTime: '1719', Location: 'LONDON', Status: 'SHIPMENT RECEIVED' }] }, '123');
  assert.equal(track.status, 'IN_TRANSIT');
  assert.equal(track.events[0]?.occurredAt.toISOString(), '2023-03-03T17:19:00.000Z');
  assert.equal(dpdTrackingStatus('Shipper created a label, UPS has not received the package yet.'), 'LABEL_CREATED');
  assert.equal(dpdTrackingStatus('NOT DELIVERED'), 'EXCEPTION');
});

test('DPD connector posts documented JSON paths and never exposes credentials in returned metadata', async () => {
  const original = global.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  global.fetch = async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ResponseCode: 'RT01', Status: 'Success', ErrorCode: '0', AWBNo: 'AWB-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const connector = new DpdRelayConnector();
    const result = await connector.create(profile, { UserID: profile.userId, Password: profile.password });
    await connector.track(profile, 'AWB-1');
    assert.equal(calls[0]?.url, 'https://example.test/api/v1/Awbentry/Awbentry');
    assert.equal(calls[1]?.url, 'https://example.test/api/v1/Tracking/Tracking');
    assert.equal(calls[1]?.body.Type, 'A');
    assert.equal(result.body.AWBNo, 'AWB-1');
    assert.equal(JSON.stringify(result).includes(profile.password), false);
  } finally { global.fetch = original; }
});

test('DPD connector retains diagnostic response for HTTP and malformed JSON errors', async () => {
  const original = global.fetch;
  try {
    const connector = new DpdRelayConnector();
    global.fetch = async () => new Response(JSON.stringify({ errors: [{ field: 'ProductCode', message: 'Invalid' }] }), { status: 422 });
    await assert.rejects(connector.create(profile, {}), (error: unknown) => error instanceof DpdRequestError && error.upstreamStatus === 422 && (error.responseBody as any)?.errors?.[0]?.field === 'ProductCode');
    global.fetch = async () => new Response('Unexpected upstream text', { status: 200, headers: { 'content-type': 'text/plain' } });
    await assert.rejects(connector.create(profile, {}), (error: unknown) => error instanceof DpdRequestError && (error.responseBody as any)?.rawText === 'Unexpected upstream text');
  } finally { global.fetch = original; }
});
