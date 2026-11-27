import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { routeFieldSchema } from './connector-drivers.registry';
import { FedexRelayMapper } from './fedex-relay.mapper';

test('泛欧 FedEx 的原产国和商品净重留空时不下发，填写后正常映射', async () => {
  const schema = routeFieldSchema('FEDEX_RELAY', 'COMMODITIES', {}, 'PAN_EUROPE');
  assert.equal(schema.declarationRequired.includes('originCountryCode'), false);
  assert.equal(schema.declarationRequired.includes('itemWeightKg'), false);
  const mapper = new FedexRelayMapper({
    assertReady: () => undefined,
    connection: () => ({ fedexAccountNumber: 'test-account', shipper: { name: 'Sender', company: 'Sender Ltd', phone: '1234567890', streetLines: ['Street 1'], city: 'Amsterdam', postalCode: '1012JS', countryCode: 'NL' } }),
  } as any, { carrierLabelSpecification: async () => ({ labelFormatType: 'COMMON2D', imageType: 'PDF', labelStockType: 'PAPER_4X6' }) } as any);
  const item = { englishName: 'Sample', harmonizedCode: '392690', quantity: 1, unitDeclaredValue: '2.00', declaredValueCurrency: 'EUR' };
  const order: any = {
    orderNo: 'ORD-TEST', supplierRouteSnapshot: { carrierServiceType: 'FEDEX_REGIONAL_ECONOMY', fieldSchema: { customsMode: 'COMMODITIES', shipmentOptions: [] } },
    service: { supplierId: 'supplier-1', supplier: { code: 'FEDEX-TEST', driverCode: 'FEDEX_RELAY' } },
    recipientName: 'Recipient', recipientPhone: '1234567890', recipientCity: 'Madrid', recipientPostcode: '28001', recipientCountryCode: 'ES', recipientAddressLine1: 'Street 2',
    recipientResidential: false, taxWith: 0, deliveryWith: '', exportWith: 0, importWith: 0, shipmentAttrs: [],
    boxes: [{ boxNo: 'BOX-1', weightKg: '2', lengthCm: '20', widthCm: '15', heightCm: '10', items: [item] }],
  };
  const withoutOrigin: any = await mapper.buildShipment(order);
  assert.equal(Object.hasOwn(withoutOrigin.requestedShipment.customsClearanceDetail.commodities[0], 'countryOfManufacture'), false);
  assert.equal(Object.hasOwn(withoutOrigin.requestedShipment.customsClearanceDetail.commodities[0], 'weight'), false);
  order.boxes[0].items[0] = { ...item, originCountryCode: 'CN', itemWeightKg: '1' };
  const withOrigin: any = await mapper.buildShipment(order);
  assert.equal(withOrigin.requestedShipment.customsClearanceDetail.commodities[0].countryOfManufacture, 'CN');
  assert.deepEqual(withOrigin.requestedShipment.customsClearanceDetail.commodities[0].weight, { units: 'KG', value: 1 });
});
