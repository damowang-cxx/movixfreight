import { strict as assert } from 'node:assert';
import test from 'node:test';
import { calculateCustomerQuote, calculateSupplierBaseFreight, calculateSupplierGridFreight, calculateSupplierPriceColumnCost, calculateSupplierVolumeFreight, calculateVolumeM3, calculateVolumetricWeightKg } from './index';

const rate = {
  tiers: [
    { minKg: '0', maxKg: '2', fixedAmount: '4.94' },
    { minKg: '2.01', maxKg: '5', fixedAmount: '4.99' },
    { minKg: '20.01', maxKg: '25', fixedAmount: '6.39' },
  ],
  perKgAboveKg: '30',
  perKgRate: '0.39',
  minimumPerBox: '4.94',
};

test('按票计重使用区间价并应用每箱最低收费', () => {
  assert.equal(calculateSupplierBaseFreight({ measurementMethod: 'PER_SHIPMENT', chargeableWeightsKg: ['22'], rate }), '6.39');
  assert.equal(calculateSupplierBaseFreight({ measurementMethod: 'PER_SHIPMENT', chargeableWeightsKg: ['34'], rate }), '13.26');
});

test('按箱计重时逐箱应用最低收费', () => {
  assert.equal(calculateSupplierBaseFreight({ measurementMethod: 'PER_BOX', chargeableWeightsKg: ['1', '1'], rate }), '9.88');
});

test('成本矩阵支持按票固定价、每公斤和最低箱收费', () => {
  const tiers = [{ minKg: '0', maxKg: '20', amount: '6.10', billingUnit: 'PER_SHIPMENT' as const }, { minKg: '20.001', maxKg: '999999.999', amount: '0.22', billingUnit: 'PER_KG' as const }];
  assert.equal(calculateSupplierGridFreight({ chargeableWeightsKg: ['10', '10'], tiers, minimumPerBox: '4.00' }), '8.00');
  assert.equal(calculateSupplierGridFreight({ chargeableWeightsKg: ['34'], tiers, minimumPerBox: '4.00' }), '7.48');
});

test('成本矩阵按箱价格逐箱取段后汇总', () => {
  const tiers = [{ minKg: '0', maxKg: '5', amount: '3.00', billingUnit: 'PER_BOX' as const }, { minKg: '5.001', maxKg: '999999.999', amount: '5.00', billingUnit: 'PER_BOX' as const }];
  assert.equal(calculateSupplierGridFreight({ chargeableWeightsKg: ['2', '6'], tiers, minimumPerBox: '4.00' }), '9.00');
});

test('价格列分别计算最低箱、最低票、挂号费与操作费', () => {
  const result = calculateSupplierPriceColumnCost({
    chargeableWeightsKg: ['1', '1'],
    tiers: [{ minKg: '0', maxKg: '5', amount: '3.00', billingUnit: 'PER_BOX' }],
    minimumPerBox: '4.00', minimumPerShipment: '9.00', registrationFee: '0.55', operationFeePerKg: '0.25',
  });
  assert.deepEqual(result, { weightFreight: '6.00', minimumPerBoxAdjustment: '2.00', minimumPerShipmentAdjustment: '1.00', supplierBaseFreight: '9.00', registrationFee: '0.55', operationFee: '0.50', supplierTotalCost: '10.05' });
});

test('按票服务仍按实际箱数应用最低箱运费', () => {
  const result = calculateSupplierPriceColumnCost({
    chargeableWeightsKg: ['5'], boxCount: 3,
    tiers: [{ minKg: '0', maxKg: '10', amount: '8.00', billingUnit: 'PER_SHIPMENT' }],
    minimumPerBox: '4.00',
  });
  assert.equal(result.supplierBaseFreight, '12.00');
  assert.equal(result.minimumPerBoxAdjustment, '4.00');
});

test('附加费逐项舍入再汇总', () => {
  const result = calculateCustomerQuote('10', { mode: 'PERCENT_OF_COST', value: '10' }, { fuelPercent: '12.345', remoteFee: '1.005', overweightFee: '0.005' });
  assert.deepEqual(result, { supplierBaseFreight: '10.00', serviceProfit: '1.00', customerBaseFreight: '11.00', fuelFee: '1.36', remoteFee: '1.01', overweightFee: '0.01', total: '13.38' });
});

test('按票和按箱体积计费使用 m³ 单价及每箱最低收费', () => {
  assert.equal(calculateVolumeM3('50', '40', '30'), '0.060000');
  assert.equal(calculateVolumetricWeightKg('50', '40', '30', '5000'), '12.000');
  assert.equal(calculateSupplierVolumeFreight({ measurementMethod: 'PER_SHIPMENT', volumesM3: ['0.060000', '0.020000'], perCubicMeterRate: '100', minimumPerBox: '3' }), '8.00');
  assert.equal(calculateSupplierVolumeFreight({ measurementMethod: 'PER_BOX', volumesM3: ['0.010000', '0.020000'], perCubicMeterRate: '100', minimumPerBox: '3' }), '6.00');
});
