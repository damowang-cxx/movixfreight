import Decimal from 'decimal.js';

export function roundCurrency(value: Decimal.Value): string {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function calculateVolumeM3(lengthCm: Decimal.Value, widthCm: Decimal.Value, heightCm: Decimal.Value): string {
  return new Decimal(lengthCm).mul(widthCm).mul(heightCm).div(1_000_000).toFixed(6);
}

export function maxChargeableWeight(estimatedWeightKg: Decimal.Value, volumetricWeightKg: Decimal.Value): string {
  return Decimal.max(new Decimal(estimatedWeightKg), new Decimal(volumetricWeightKg)).toFixed(3);
}

export function calculateVolumetricWeightKg(lengthCm: Decimal.Value, widthCm: Decimal.Value, heightCm: Decimal.Value, divisor: Decimal.Value): string {
  const divisorDecimal = new Decimal(divisor);
  if (divisorDecimal.lessThanOrEqualTo(0)) throw new Error('计抛系数必须大于 0');
  return new Decimal(lengthCm).mul(widthCm).mul(heightCm).div(divisorDecimal).toFixed(3);
}

export interface WeightTier {
  minKg: Decimal.Value;
  maxKg: Decimal.Value;
  fixedAmount: Decimal.Value;
}

export interface WeightRate {
  tiers: WeightTier[];
  perKgAboveKg?: Decimal.Value;
  perKgRate?: Decimal.Value;
  minimumPerBox?: Decimal.Value;
}

export interface BaseFreightInput {
  measurementMethod: 'PER_SHIPMENT' | 'PER_BOX';
  chargeableWeightsKg: Decimal.Value[];
  rate: WeightRate;
}

export interface GridWeightTier {
  minKg: Decimal.Value;
  maxKg: Decimal.Value;
  amount: Decimal.Value;
  billingUnit: 'PER_SHIPMENT' | 'PER_BOX' | 'PER_KG';
}

export interface SupplierPriceColumnCostInput {
  chargeableWeightsKg: Decimal.Value[];
  /** Actual parcel count. It can differ from weight values for a per-shipment service. */
  boxCount?: number;
  tiers: GridWeightTier[];
  minimumPerBox?: Decimal.Value;
  minimumPerShipment?: Decimal.Value;
  registrationFee?: Decimal.Value;
  operationFeePerKg?: Decimal.Value;
}

export interface SupplierPriceColumnCost {
  weightFreight: string;
  minimumPerBoxAdjustment: string;
  minimumPerShipmentAdjustment: string;
  supplierBaseFreight: string;
  registrationFee: string;
  operationFee: string;
  supplierTotalCost: string;
}

/** 成本表重量矩阵：按票固定价、按箱固定价和每公斤价格可在同一表中混用。 */
export function calculateSupplierGridFreight(input: { chargeableWeightsKg: Decimal.Value[]; tiers: GridWeightTier[]; minimumPerBox?: Decimal.Value; boxCount?: number }): string {
  return calculateSupplierPriceColumnCost(input).supplierBaseFreight;
}

/**
 * Calculates a supplier price column and retains each protection/extra cost as
 * a separate amount for quoting and order fee snapshots.
 */
export function calculateSupplierPriceColumnCost(input: SupplierPriceColumnCostInput): SupplierPriceColumnCost {
  if (!input.chargeableWeightsKg.length) throw new Error('至少需要一个箱号的计费重量');
  const weights = input.chargeableWeightsKg.map((value) => new Decimal(value)); const boxCount = input.boxCount ?? weights.length; if (!Number.isInteger(boxCount) || boxCount < 1) throw new Error('箱数必须为正整数'); const total = weights.reduce((sum, value) => sum.plus(value), new Decimal(0)); const minimumBox = new Decimal(input.minimumPerBox ?? 0); const minimumShipment = new Decimal(input.minimumPerShipment ?? 0);
  const find = (weight: Decimal) => input.tiers.find((tier) => weight.greaterThanOrEqualTo(tier.minKg) && weight.lessThanOrEqualTo(tier.maxKg)); const totalTier = find(total);
  if (!totalTier) throw new Error(`未找到 ${total.toFixed(3)}kg 对应的成本价格`);
  let weightFreight: Decimal;
  let afterMinimumBox: Decimal;
  if (totalTier.billingUnit === 'PER_SHIPMENT') {
    weightFreight = new Decimal(totalTier.amount);
    afterMinimumBox = Decimal.max(weightFreight, minimumBox.mul(boxCount));
  } else if (totalTier.billingUnit === 'PER_KG') {
    weightFreight = total.mul(totalTier.amount);
    afterMinimumBox = Decimal.max(weightFreight, minimumBox.mul(boxCount));
  } else {
    const protectedBoxes = weights.map((weight) => {
      const tier = find(weight);
      if (!tier || tier.billingUnit !== 'PER_BOX') throw new Error(`未找到 ${weight.toFixed(3)}kg 对应的按箱成本价格`);
      return { raw: new Decimal(tier.amount), protected: Decimal.max(new Decimal(tier.amount), minimumBox) };
    });
    weightFreight = protectedBoxes.reduce((sum, box) => sum.plus(box.raw), new Decimal(0));
    afterMinimumBox = protectedBoxes.reduce((sum, box) => sum.plus(box.protected), new Decimal(0));
  }
  const afterMinimumShipment = Decimal.max(afterMinimumBox, minimumShipment);
  const registrationFee = new Decimal(roundCurrency(input.registrationFee ?? 0));
  const operationFee = new Decimal(roundCurrency(total.mul(input.operationFeePerKg ?? 0)));
  return {
    weightFreight: roundCurrency(weightFreight),
    minimumPerBoxAdjustment: roundCurrency(afterMinimumBox.minus(weightFreight)),
    minimumPerShipmentAdjustment: roundCurrency(afterMinimumShipment.minus(afterMinimumBox)),
    supplierBaseFreight: roundCurrency(afterMinimumShipment),
    registrationFee: registrationFee.toFixed(2),
    operationFee: operationFee.toFixed(2),
    supplierTotalCost: roundCurrency(afterMinimumShipment.plus(registrationFee).plus(operationFee)),
  };
}

export interface ProfitRule {
  mode: 'PERCENT_OF_COST' | 'FIXED_AMOUNT';
  value: Decimal.Value;
}

export interface SurchargeInput {
  fuelPercent?: Decimal.Value;
  remoteFee?: Decimal.Value;
  overweightFee?: Decimal.Value;
}

export interface QuoteResult {
  supplierBaseFreight: string;
  serviceProfit: string;
  customerBaseFreight: string;
  fuelFee: string;
  remoteFee: string;
  overweightFee: string;
  total: string;
}

function calculateSingleWeightFreight(weightKg: Decimal, rate: WeightRate): Decimal {
  if (weightKg.lessThanOrEqualTo(0)) throw new Error('计费重量必须大于 0');
  const perKgThreshold = rate.perKgAboveKg === undefined ? undefined : new Decimal(rate.perKgAboveKg);
  if (perKgThreshold && weightKg.greaterThan(perKgThreshold)) {
    if (rate.perKgRate === undefined) throw new Error('超过阈值后未配置每公斤价格');
    return weightKg.mul(rate.perKgRate);
  }

  const tier = rate.tiers.find((item) => weightKg.greaterThanOrEqualTo(item.minKg) && weightKg.lessThanOrEqualTo(item.maxKg));
  if (!tier) throw new Error(`未找到 ${weightKg.toFixed(3)}kg 对应的固定区间价格`);
  return new Decimal(tier.fixedAmount);
}

/**
 * 计算供应商基础运费。按票计重时，先按整票重量取价，再以每箱最低收费保护；
 * 按箱计重时，每箱独立取价和应用最低收费，最后汇总。
 */
export function calculateSupplierBaseFreight(input: BaseFreightInput): string {
  if (!input.chargeableWeightsKg.length) throw new Error('至少需要一个箱号的计费重量');
  const minimum = new Decimal(input.rate.minimumPerBox ?? 0);
  const weights = input.chargeableWeightsKg.map((value) => new Decimal(value));

  if (input.measurementMethod === 'PER_SHIPMENT') {
    const base = calculateSingleWeightFreight(weights.reduce((sum, item) => sum.plus(item), new Decimal(0)), input.rate);
    return roundCurrency(Decimal.max(base, minimum.mul(weights.length)));
  }

  return roundCurrency(weights.reduce((sum, weight) => {
    const perBox = calculateSingleWeightFreight(weight, input.rate);
    return sum.plus(Decimal.max(perBox, minimum));
  }, new Decimal(0)));
}

export interface VolumeFreightInput {
  measurementMethod: 'PER_SHIPMENT' | 'PER_BOX';
  volumesM3: Decimal.Value[];
  perCubicMeterRate: Decimal.Value;
  minimumPerBox?: Decimal.Value;
}

/** 按体积计费：每箱体积以 cm³ / 1,000,000 转为 m³；按票时汇总体积后取价，按箱时逐箱取价并应用每箱最低收费。 */
export function calculateSupplierVolumeFreight(input: VolumeFreightInput): string {
  if (!input.volumesM3.length) throw new Error('至少需要一个箱号的体积数据');
  const rate = new Decimal(input.perCubicMeterRate);
  if (rate.lessThan(0)) throw new Error('每立方米价格不能为负数');
  const minimum = new Decimal(input.minimumPerBox ?? 0);
  const volumes = input.volumesM3.map((value) => new Decimal(value));
  if (volumes.some((value) => value.lessThanOrEqualTo(0))) throw new Error('计费体积必须大于 0');

  if (input.measurementMethod === 'PER_SHIPMENT') {
    const totalVolume = volumes.reduce((sum, value) => sum.plus(value), new Decimal(0));
    return roundCurrency(Decimal.max(totalVolume.mul(rate), minimum.mul(volumes.length)));
  }
  return roundCurrency(volumes.reduce((sum, volume) => sum.plus(Decimal.max(volume.mul(rate), minimum)), new Decimal(0)));
}

/** 每个附加费在其规则计算结束后即四舍五入至两位小数，再汇总。 */
export function calculateCustomerQuote(
  supplierBaseFreight: Decimal.Value,
  profit: ProfitRule,
  surcharge: SurchargeInput = {},
): QuoteResult {
  const cost = new Decimal(supplierBaseFreight);
  const serviceProfit = profit.mode === 'PERCENT_OF_COST'
    ? cost.mul(profit.value).div(100)
    : new Decimal(profit.value);
  const customerBase = cost.plus(serviceProfit);
  const fuelFee = surcharge.fuelPercent === undefined ? new Decimal(0) : new Decimal(roundCurrency(customerBase.mul(surcharge.fuelPercent).div(100)));
  const remoteFee = surcharge.remoteFee === undefined ? new Decimal(0) : new Decimal(roundCurrency(surcharge.remoteFee));
  const overweightFee = surcharge.overweightFee === undefined ? new Decimal(0) : new Decimal(roundCurrency(surcharge.overweightFee));
  const total = customerBase.plus(fuelFee).plus(remoteFee).plus(overweightFee);

  return {
    supplierBaseFreight: roundCurrency(cost),
    serviceProfit: roundCurrency(serviceProfit),
    customerBaseFreight: roundCurrency(customerBase),
    fuelFee: fuelFee.toFixed(2),
    remoteFee: remoteFee.toFixed(2),
    overweightFee: overweightFee.toFixed(2),
    total: roundCurrency(total),
  };
}
