import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { UpsOfficialConfig, UpsProfile, upsHost } from './ups-official.config';
import { UpsOfficialConnector, UpsRequestError, UPS_SHIP_PATH } from './ups-official.connector';
import { assertUpsInput, buildUpsShipment } from './ups-official.mapper';
import { getConnectorDriver, routeFieldSchema } from './connector-drivers.registry';
import { normalizeRecipientAddress } from '../orders/recipient-address';

import { profile, upsOrder } from '../../test/ups-fixtures';

test('UPS has independent driver capabilities and requires printable descriptions, not customs', () => {
  assert.equal(getConnectorDriver('UPS_OFFICIAL')?.capabilities.cancel, true);
  assert.deepEqual(routeFieldSchema('UPS_OFFICIAL', 'NONE', {}).declarationRequired, ['englishName']);
  assert.equal(routeFieldSchema('UPS_OFFICIAL', 'NONE', {}).addressLineLimit, 35);
  assert.equal(routeFieldSchema('FEDEX_RELAY', 'NONE', {}).addressLineLimit, 20);
});
test('UPS exact profile lookup, safe status, no root or FedEx fallback', () => {
  const config = new UpsOfficialConfig({} as any);
  (config as any).profiles = () => ({ UPS1: profile });
  assert.equal(config.status('UPS1').configured, true);
  assert.equal(config.status('MISSING').configured, false);
  assert.throws(() => config.connection('MISSING', 'PRODUCTION'), /未就绪/);
  assert.throws(() => config.connection('UPS1', 'SANDBOX'), /不匹配/);
  const status = JSON.stringify(config.status('UPS1'));
  for (const secret of [profile.clientId, profile.clientSecret, profile.shipperNumber]) assert.equal(status.includes(secret), false);
  (config as any).profiles = () => ({ UPS1: { ...profile, shipper: { ...profile.shipper, countryCode: 'US' } } });
  assert.equal(config.status('UPS1').configured, false);
});
test('malformed UPS profile reports missing fields without leaking values or crashing', () => {
  const config = new UpsOfficialConfig({} as any);
  for (const p of [null, { ...profile, enabled: 'true' }, { ...profile, clientSecret: 12 }, { ...profile, shipper: { ...profile.shipper, streetLines: 'not-an-array', phone: null } }]) {
    (config as any).profiles = () => ({ UPS1: p });
    assert.equal(config.status('UPS1').configured, false);
    assert.throws(() => config.connection('UPS1', 'PRODUCTION'), /未就绪/);
  }
});

test('UPS 35-character splitting is isolated from FedEx 20 and preserves words/order', () => {
  const parts = ['ABCDEFGHIJKLMNOPQRSTUVW 1', ' Main street  apartment 3 ', 'Amsterdam'];
  assert.throws(() => normalizeRecipientAddress(parts), /超过 20/);
  const normalized = normalizeRecipientAddress(parts, 'UPS_OFFICIAL');
  assert.equal(normalized.lines.join(' '), 'ABCDEFGHIJKLMNOPQRSTUVW 1 Main street apartment 3 Amsterdam');
  assert.ok(normalized.lines.every(line => Array.from(line).length <= 35));
  assert.throws(() => normalizeRecipientAddress(['A'.repeat(36)], 'UPS_OFFICIAL'), /超过 35/);
  assert.throws(() => normalizeRecipientAddress(Array(4).fill('A'.repeat(35)), 'UPS_OFFICIAL'), /最多 3/);
});
test('Shipping validate creates once, Standard 11, account payer and native cm/kg, no customs', () => {
  const payload = buildUpsShipment(upsOrder(), profile).ShipmentRequest;
  assert.equal(payload.Request.RequestOption, 'validate');
  assert.equal(payload.Shipment.Service.Code, '11');
  assert.equal(payload.Shipment.PaymentInformation.ShipmentCharge.BillShipper.AccountNumber, profile.shipperNumber);
  assert.equal(payload.Shipment.Package.length, 2);
  assert.equal(payload.Shipment.Package[0].PackageWeight.UnitOfMeasurement.Code, 'KGS');
  assert.equal(payload.LabelSpecification.LabelImageFormat.Code, 'GIF');
  assert.equal(JSON.stringify(payload).includes('InternationalForms'), false);
});
test('precharge rejects unsupported fields, destinations, size, descriptions and malformed address', () => {
  assert.doesNotThrow(() => assertUpsInput(upsOrder()));
  for (const patch of [{ recipientCountryCode: 'GB' }, { deliveryWith: 'ddp' }, { taxNumber: '123' }, { shipmentAttrs: ['danger'] }, { recipientCountryCode: 'ES', recipientPostcode: '35001' }, { recipientPhone: '' }, { recipientAddressRaw: 'X'.repeat(36) }, { recipientCountryCode: 'IE', recipientState: '' }]) assert.throws(() => assertUpsInput({ ...upsOrder(), ...patch }));
  for (const patch of [{ weightKg: '71' }, { lengthCm: '300' }, { weightKg: '0' }, { items: [{ englishName: '中文' }] }]) { const order = upsOrder(); Object.assign(order.boxes[0], patch); assert.throws(() => assertUpsInput(order)); }
});
test('OAuth singleflight cache isolated by profile/env/credential rotation, correct hosts and POST/DELETE contract', async () => {
  const previous = globalThis.fetch; const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify(String(url).includes('/oauth/') ? { access_token: 'TOKEN', expires_in: '3600' } : { ok: true }), { status: 200 }); };
  try {
    const connector = new UpsOfficialConnector();
    await Promise.all([connector.getAccessToken('UPS1', profile), connector.getAccessToken('UPS1', profile)]);
    await connector.getAccessToken('UPS1', profile); assert.equal(calls.length, 1);
    await connector.getAccessToken('UPS2', profile);
    await connector.getAccessToken('UPS1', { ...profile, environment: 'sandbox' });
    await connector.getAccessToken('UPS1', { ...profile, clientSecret: 'rotated' }); assert.equal(calls.length, 4);
    assert.ok(calls[0].url.startsWith(upsHost('production'))); assert.ok(calls[2].url.startsWith(upsHost('sandbox')));
    assert.equal(calls[0].init.body, 'grant_type=client_credentials');
    await connector.create(profile, 'TOKEN', buildUpsShipment(upsOrder(), profile));
    await connector.cancel(profile, 'TOKEN', '1ZABC1230000000001');
    assert.equal(calls[4].url, upsHost('production') + UPS_SHIP_PATH); assert.equal(calls[4].init.method, 'POST');
    assert.equal(calls[5].init.method, 'DELETE'); assert.ok(calls[5].url.endsWith('/void/cancel/1ZABC1230000000001')); assert.equal(calls[5].init.body, undefined); assert.equal(calls[5].url.includes('?'), false);
  } finally { globalThis.fetch = previous; }
});
test('structured rejection differs from unknown; no network auto retry; OAuth errors contain no secrets', async () => {
  const previous = globalThis.fetch; let calls = 0;
  try {
    const connector = new UpsOfficialConnector();
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ response: { errors: [{ code: '120100', message: `Denied ${profile.clientSecret}` }] } }), { status: 400 }); };
    await assert.rejects(connector.create(profile, 'token', {}), (e: any) => e instanceof UpsRequestError && !e.unknown && !JSON.stringify(e.getResponse()).includes(profile.clientSecret));
    globalThis.fetch = async () => { calls++; throw new TypeError('network'); };
    await assert.rejects(connector.create(profile, 'token', {}), (e: any) => e.unknown === true);
    await assert.rejects(connector.getAccessToken('UPS1', profile), (e: any) => e.phase === 'OAUTH' && e.unknown === false);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = previous; }
});

test('Belgian origin config accepts optional state and normalizes country, rejects other origins', () => {
  const config = new UpsOfficialConfig({} as any);
  for (const stateCode of [undefined, '', '   ']) {
    (config as any).profiles = () => ({ UPS1: { ...profile, shipper: { ...profile.shipper, city: 'TERNAT', postalCode: '1740', countryCode: ' be ', stateCode } } });
    assert.equal(config.status('UPS1').configured, true);
    const connection = config.connection('UPS1', 'PRODUCTION');
    assert.equal(connection.shipper.countryCode, 'BE');
    assert.equal(connection.shipper.stateCode, undefined);
  }
  for (const countryCode of ['', 'US', 'FR']) {
    (config as any).profiles = () => ({ UPS1: { ...profile, shipper: { ...profile.shipper, countryCode } } });
    assert.equal(config.status('UPS1').configured, false);
  }
});

test('Belgian Shipper and ShipFrom use BE for domestic and EU orders, NL remains compatible', () => {
  const belgian: UpsProfile = { ...profile, shipper: { ...profile.shipper, streetLines: ['INDUSTRIELAAN 31'], city: 'TERNAT', postalCode: '1740', countryCode: 'BE', stateCode: '' } };
  for (const recipientCountryCode of ['BE', 'NL', 'DE']) {
    const order = { ...upsOrder(), recipientCountryCode, supplierRouteSnapshot: { ...upsOrder().supplierRouteSnapshot, shipperCountryCode: 'BE' } };
    const shipment = buildUpsShipment(order, belgian).ShipmentRequest.Shipment;
    assert.equal(shipment.Shipper.Address.CountryCode, 'BE');
    assert.equal(shipment.ShipFrom.Address.CountryCode, 'BE');
    assert.equal(shipment.ShipTo.Address.CountryCode, recipientCountryCode);
    assert.equal(shipment.Service.Code, '11');
    assert.equal('StateProvinceCode' in shipment.Shipper.Address, false);
    assert.equal(shipment.ShipFrom.Address.PostalCode, '1740');
  }
  assert.equal(buildUpsShipment(upsOrder(), profile).ShipmentRequest.Shipment.ShipFrom.Address.CountryCode, 'NL');
  assert.throws(() => buildUpsShipment(upsOrder(), belgian), /发件国与订单创建时不一致/);
  assert.throws(() => buildUpsShipment({ ...upsOrder(), supplierRouteSnapshot: { ...upsOrder().supplierRouteSnapshot, shipperCountryCode: 'BE' } }, profile), /发件国与订单创建时不一致/);
});
