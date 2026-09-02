import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BillingMethod, CostBillingUnit, CostPostcodeRuleType, PriceVersionStatus, Prisma, ProfitMode, ProfitScope } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { calculateCustomerQuote, calculateSupplierPriceColumnCost, calculateVolumeM3, calculateVolumetricWeightKg, maxChargeableWeight, type ProfitRule } from '@movix/pricing-engine';
import * as XLSX from 'xlsx';

type ProfitRow = { countryCode: string; mode: ProfitMode; value: string };
type ProfitVersionInput = { serviceId: string; versionNo: string; scope: ProfitScope; scopeTargetId?: string | null; sourceCostVersionId?: string | null; defaultMode?: ProfitMode; defaultValue?: string; currency: 'EUR' | 'GBP'; status: PriceVersionStatus; effectiveFrom: string; effectiveTo?: string | null; rows?: ProfitRow[] };
export type QuoteBoxDimensions = { lengthCm: string; widthCm: string; heightCm: string };
export type QuoteOptions = { asOf?: Date; useProvidedChargeableWeights?: boolean };
type CostTableInput = { supplierId: string; versionNo: string; countriesText: string; currency: 'EUR' | 'GBP'; status: PriceVersionStatus; effectiveFrom: string; effectiveTo: string; minWeightKg: string; maxWeightKg?: string; minBoxes: number; maxBoxes?: number };
type GridRule = { minKg: string; maxKg?: string; billingUnit: CostBillingUnit };
type PriceColumn = { countryCode: string; postcodeRuleType: CostPostcodeRuleType; postcodeRuleStart: string; postcodeRuleEnd?: string; minimumPerShipment: string; minimumPerBox: string; registrationFee: string; operationFeePerKg: string; prices: string[] };
type ParsedGrid = { rules: GridRule[]; columns: PriceColumn[] };

const EUROPEAN_COUNTRIES = [['AT', '奥地利'], ['BE', '比利时'], ['BG', '保加利亚'], ['CH', '瑞士'], ['CZ', '捷克'], ['DE', '德国'], ['DK', '丹麦'], ['EE', '爱沙尼亚'], ['ES', '西班牙'], ['FI', '芬兰'], ['FR', '法国'], ['GB', '英国'], ['GR', '希腊'], ['HR', '克罗地亚'], ['HU', '匈牙利'], ['IE', '爱尔兰'], ['IT', '意大利'], ['LT', '立陶宛'], ['LU', '卢森堡'], ['LV', '拉脱维亚'], ['NL', '荷兰'], ['NO', '挪威'], ['PL', '波兰'], ['PT', '葡萄牙'], ['RO', '罗马尼亚'], ['SE', '瑞典'], ['SI', '斯洛文尼亚'], ['SK', '斯洛伐克']] as const;

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureCountries() { await this.prisma.country.createMany({ data: EUROPEAN_COUNTRIES.map(([code, chineseName]) => ({ code, chineseName })), skipDuplicates: true }); }
  async countries() { await this.ensureCountries(); return this.prisma.country.findMany({ orderBy: { code: 'asc' } }); }
  async resolveDestinationCountry(value: string) {
    const normalized = value.trim();
    if (!normalized) throw new BadRequestException('目的国家不能为空');
    await this.ensureCountries();
    const country = await this.prisma.country.findFirst({ where: { enabled: true, OR: [{ code: normalized.toUpperCase() }, { chineseName: normalized }] } });
    if (!country) throw new BadRequestException(`目的国家“${value}”不存在或已停用，请在国家表中维护后重试`);
    return country.code;
  }
  async createCountry(input: { code: string; chineseName: string }) { const code = input.code.trim().toUpperCase(); const chineseName = input.chineseName.trim(); if (!/^[A-Z]{2}$/.test(code) || !chineseName) throw new BadRequestException('国家代码必须为两位字母，中文国家名不能为空'); try { return await this.prisma.country.create({ data: { code, chineseName } }); } catch { throw new ConflictException('国家代码或中文国家名已存在'); } }
  async setCountryEnabled(code: string, enabled: boolean) { await this.ensureCountries(); return this.prisma.country.update({ where: { code: code.toUpperCase() }, data: { enabled } }); }

  async costTables() { await this.ensureCountries(); return this.prisma.supplierCostVersion.findMany({ include: { supplier: { select: { code: true, name: true, carrier: { select: { name: true } } } }, countries: { include: { country: true } }, rows: { include: { tiers: true } } }, orderBy: { createdAt: 'desc' } }); }
  async costTable(id: string) { await this.ensureCountries(); const table = await this.prisma.supplierCostVersion.findUnique({ where: { id }, include: { supplier: { include: { carrier: true } }, countries: { include: { country: true } }, rows: { include: { tiers: { orderBy: { minKg: 'asc' } } } } } }); if (!table) throw new NotFoundException('成本表不存在'); return table; }

  async createCostTable(input: CostTableInput) {
    await this.ensureCountries(); const countries = await this.resolveCountries(input.countriesText); const header = this.normalizeHeader(input); const supplier = await this.prisma.supplier.findUnique({ where: { id: input.supplierId } }); if (!supplier) throw new NotFoundException('供应商连接不存在');
    const status = input.status ?? PriceVersionStatus.ACTIVE; if (status === PriceVersionStatus.ACTIVE || status === PriceVersionStatus.SCHEDULED) await this.assertNoCostTableOverlap(input.supplierId, countries.map((item) => item.code), header, undefined);
    try { return await this.prisma.supplierCostVersion.create({ data: { versionNo: input.versionNo.trim(), currency: input.currency, status, effectiveFrom: header.start, effectiveTo: header.end, minWeightKg: header.minWeight, maxWeightKg: header.maxWeight, minBoxes: header.minBoxes, maxBoxes: header.maxBoxes, carrierId: supplier.carrierId, supplierConnectionId: supplier.id, countries: { create: countries.map((country) => ({ countryCode: country.code })) } }, include: { countries: { include: { country: true } } } }); } catch { throw new ConflictException('成本表版本号已存在或参数无效'); }
  }
  async updateCostTable(tableId: string, input: CostTableInput) {
    const existing = await this.costTable(tableId); await this.ensureCountries(); const countries = await this.resolveCountries(input.countriesText); const header = this.normalizeHeader(input); const supplier = await this.prisma.supplier.findUnique({ where: { id: input.supplierId } }); if (!supplier) throw new NotFoundException('供应商连接不存在');
    const status = input.status ?? PriceVersionStatus.ACTIVE; if (status === PriceVersionStatus.ACTIVE || status === PriceVersionStatus.SCHEDULED) await this.assertNoCostTableOverlap(supplier.id, countries.map((item) => item.code), header, tableId);
    const countriesChanged = existing.countries.map((item) => item.countryCode).sort().join(',') !== countries.map((item) => item.code).sort().join(',');
    try { await this.prisma.$transaction(async (tx) => { if (countriesChanged) await tx.supplierCostRate.deleteMany({ where: { versionId: tableId } }); await tx.supplierCostVersion.update({ where: { id: tableId }, data: { versionNo: input.versionNo.trim(), currency: input.currency, status, effectiveFrom: header.start, effectiveTo: header.end, minWeightKg: header.minWeight, maxWeightKg: header.maxWeight, minBoxes: header.minBoxes, maxBoxes: header.maxBoxes, carrierId: supplier.carrierId, supplierConnectionId: supplier.id, ...(countriesChanged ? { countries: { deleteMany: {}, create: countries.map((country) => ({ countryCode: country.code })) } } : {}) } }); }); } catch { throw new ConflictException('成本表版本号已存在或参数无效'); }
    return { ...(await this.costTable(tableId)), priceMatrixCleared: countriesChanged };
  }

  async previewPriceGrid(tableId: string, pastedText: string) { return this.parseGrid(await this.costTable(tableId), pastedText); }
  async costTableTemplate(tableId: string) {
    const table = await this.costTable(tableId); const countries = table.countries.map((item) => item.country.chineseName); const row = (label: string, values: string[]) => [label, '', ...values];
    const worksheet = XLSX.utils.aoa_to_sheet([['重量段', '计价单位', ...countries], ['0-1', '按票', ...countries.map(() => '0.00')], ['1.01-2', '按票', ...countries.map(() => '0.00')], ['71.01+', '每KG', ...countries.map(() => '0.00')], row('邮编开头', countries.map(() => '')), row('最低票运费', countries.map(() => '0.00')), row('最低箱运费', countries.map(() => '0.00')), row('挂号费', countries.map(() => '0.00/票')), row('操作费', countries.map(() => '0.00/KG'))]);
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, '价格矩阵'); return { filename: `${table.versionNo}-成本价格模板.xlsx`, content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer };
  }
  async costTableMatrixExport(tableId: string) {
    const table = await this.costTable(tableId);
    if (!table.rows.length) throw new BadRequestException('当前成本表尚未写入价格矩阵，无法导出当前价格表');
    const worksheet = XLSX.utils.aoa_to_sheet(this.costMatrixRows(table));
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, '价格矩阵');
    return { filename: `${table.versionNo}-当前成本价格表.xlsx`, content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer };
  }
  async replacePriceGrid(tableId: string, pastedText: string) {
    const grid = await this.parseGrid(await this.costTable(tableId), pastedText);
    await this.prisma.$transaction(async (tx) => { await tx.supplierCostRate.deleteMany({ where: { versionId: tableId } }); for (const column of grid.columns) { const rate = await tx.supplierCostRate.create({ data: { versionId: tableId, countryCode: column.countryCode, postcodeRuleType: column.postcodeRuleType, postcodeRuleStart: column.postcodeRuleStart, postcodeRuleEnd: column.postcodeRuleEnd, minimumPerShipment: column.minimumPerShipment, minimumPerBox: column.minimumPerBox, registrationFee: column.registrationFee, operationFeePerKg: column.operationFeePerKg } }); await tx.supplierCostWeightTier.createMany({ data: grid.rules.map((rule, index) => ({ costRateId: rate.id, minKg: rule.minKg, maxKg: rule.maxKg ?? '999999.999', fixedAmount: column.prices[index]!, billingUnit: rule.billingUnit })) }); } });
    return this.costTable(tableId);
  }

  async quote(customerId: string, serviceId: string, countryCode: string, chargeableWeightsKg: string[], postcode?: string, boxes: QuoteBoxDimensions[] = [], options: QuoteOptions = {}) {
    const now = options.asOf ?? new Date(); const destination = await this.resolveDestinationCountry(countryCode); const service = await this.prisma.service.findUnique({ where: { id: serviceId }, include: { supplier: { include: { carrier: { include: { fuelSurcharges: { where: { effectiveFrom: { lte: now }, effectiveTo: { gte: now } } } } } } }, remoteAreaTemplate: { include: { rules: true } } } }); if (!service?.enabled || !service.supplier.enabled || !service.supplier.carrier.enabled) throw new NotFoundException('可用服务不存在');
    const volumesM3 = boxes.map((box) => calculateVolumeM3(box.lengthCm, box.widthCm, box.heightCm)); let quotedWeightsKg = chargeableWeightsKg;
    if (service.billingMethod === BillingMethod.MAX_ACTUAL_OR_VOLUMETRIC && !options.useProvidedChargeableWeights) { const divisor = service.volumetricDivisor; if (!divisor || !volumesM3.length) throw new NotFoundException('该服务缺少计抛系数或箱子尺寸'); const volumetricWeights = boxes.map((box) => calculateVolumetricWeightKg(box.lengthCm, box.widthCm, box.heightCm, divisor.toString())); if (chargeableWeightsKg.length !== volumetricWeights.length) throw new NotFoundException('重量与箱子尺寸数量不一致'); quotedWeightsKg = chargeableWeightsKg.map((weight, index) => maxChargeableWeight(weight, volumetricWeights[index]!)); }
    if (service.billingMethod === BillingMethod.VOLUME) throw new BadRequestException('当前成本表格式首期不支持按体积计费服务');
    const totalWeight = quotedWeightsKg.reduce((sum, value) => sum.plus(value), new Prisma.Decimal(0)); const boxCount = boxes.length || quotedWeightsKg.length;
    const candidates = await this.prisma.supplierCostVersion.findMany({ where: { supplierConnectionId: service.supplierId, status: PriceVersionStatus.ACTIVE, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }], countries: { some: { countryCode: destination } } }, include: { rows: { where: { countryCode: destination }, include: { tiers: true } }, countries: true } });
    const tables = candidates.filter((table) => totalWeight.greaterThanOrEqualTo(table.minWeightKg) && (!table.maxWeightKg || totalWeight.lessThanOrEqualTo(table.maxWeightKg)) && boxCount >= table.minBoxes && (!table.maxBoxes || boxCount <= table.maxBoxes)); if (!tables.length) throw new NotFoundException(`目的国 ${destination} 的重量、箱数或生效期暂无匹配成本表`); if (tables.length > 1) throw new ConflictException('存在多个匹配成本表，请检查适用范围是否重叠');
    const table = tables[0]!; const rate = this.matchPriceColumn(table.rows, postcode, destination, table.versionNo);
    let supplier: ReturnType<typeof calculateSupplierPriceColumnCost>; try { supplier = calculateSupplierPriceColumnCost({ chargeableWeightsKg: quotedWeightsKg, boxCount, minimumPerBox: rate.minimumPerBox.toString(), minimumPerShipment: rate.minimumPerShipment.toString(), registrationFee: rate.registrationFee.toString(), operationFeePerKg: rate.operationFeePerKg.toString(), tiers: rate.tiers.map((tier) => ({ minKg: tier.minKg.toString(), maxKg: tier.maxKg.toString(), amount: tier.fixedAmount.toString(), billingUnit: tier.billingUnit })) }); } catch (error) { throw new NotFoundException(error instanceof Error ? `成本表 ${table.versionNo}：${error.message}` : '成本表价格计算失败'); }
    const { version: profitVersion, row: profitRow } = await this.resolveProfitVersion(customerId, serviceId, destination, now, service.code);
    const activeFuelSurcharges = service.supplier.carrier.fuelSurcharges; if (activeFuelSurcharges.length > 1) throw new ConflictException(`尾程渠道 ${service.supplier.carrier.name} 存在多个有效燃油费率，请先修正燃油费时间区间`); const activeFuelSurcharge = activeFuelSurcharges[0]; const normalizedPostcode = this.normalizePostcode(postcode); const remoteMatched = Boolean(service.remoteFeeEnabled && service.remoteAreaTemplate && normalizedPostcode && service.remoteAreaTemplate.rules.some((rule) => rule.countryCode === destination && (rule.ruleType === 'EXACT' ? normalizedPostcode === this.normalizePostcode(rule.ruleValue) : normalizedPostcode.startsWith(this.normalizePostcode(rule.ruleValue))))); const customerQuote = calculateCustomerQuote(supplier.supplierBaseFreight, { mode: profitRow.mode === ProfitMode.PERCENT_OF_COST ? 'PERCENT_OF_COST' : 'FIXED_AMOUNT', value: profitRow.value.toString() } satisfies ProfitRule, { fuelPercent: activeFuelSurcharge?.percent.toString(), remoteFee: remoteMatched ? service.remoteFeeAmount?.toString() : undefined }); const total = new Prisma.Decimal(customerQuote.total).plus(supplier.registrationFee).plus(supplier.operationFee).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
    return { currency: table.currency, countryCode: destination, postcode, billingMethod: service.billingMethod, totalVolumeM3: volumesM3.reduce((sum, value) => sum.plus(value), new Prisma.Decimal(0)).toDecimalPlaces(6).toFixed(6), calculatedChargeableWeightsKg: quotedWeightsKg, costVersion: table.versionNo, priceColumn: { countryCode: rate.countryCode, postcodeRuleType: rate.postcodeRuleType, postcodeRuleStart: rate.postcodeRuleStart, postcodeRuleEnd: rate.postcodeRuleEnd }, profitVersion: profitVersion.versionNo, profitVersionId: profitVersion.id, profitScope: profitVersion.scope, profitScopeTargetId: profitVersion.scopeTargetId, profitRule: { countryCode: profitRow.countryCode, mode: profitRow.mode, value: profitRow.value.toString() }, remoteMatched, remoteTemplateCode: remoteMatched ? service.remoteAreaTemplate?.code : undefined, fuelSurcharge: activeFuelSurcharge ? { percent: activeFuelSurcharge.percent.toString(), effectiveFrom: activeFuelSurcharge.effectiveFrom, effectiveTo: activeFuelSurcharge.effectiveTo } : null, ...supplier, ...customerQuote, total };
  }

  profitServices() { return this.prisma.service.findMany({ include: { supplier: { include: { carrier: true } }, _count: { select: { profitVersions: true } } }, orderBy: { createdAt: 'desc' } }); }
  profitVersions() { return this.prisma.serviceProfitVersion.findMany({ include: { service: { select: { code: true, name: true } }, rows: true }, orderBy: { effectiveFrom: 'desc' } }); }
  async profitService(serviceId: string) {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId }, include: { supplier: { include: { carrier: true, costVersions: { include: { countries: { include: { country: true } }, rows: { include: { tiers: { orderBy: { minKg: 'asc' } } } } }, orderBy: { effectiveFrom: 'desc' } } } }, profitVersions: { include: { sourceCostVersion: { include: { countries: { include: { country: true } }, rows: { include: { tiers: { orderBy: { minKg: 'asc' } } } } } }, rows: true, changeLogs: { orderBy: { createdAt: 'desc' }, take: 20 } }, orderBy: { effectiveFrom: 'desc' } } } });
    if (!service) throw new NotFoundException('服务不存在'); return service;
  }
  async createProfitVersion(input: ProfitVersionInput, operatorId?: string) {
    const normalized = await this.normalizeProfitVersion(input); const created = await this.prisma.serviceProfitVersion.create({ data: { ...normalized, rows: { create: normalized.rows } }, include: { rows: true } });
    await this.prisma.profitVersionChangeLog.create({ data: { versionId: created.id, changedById: operatorId, beforeSnapshot: {}, afterSnapshot: this.profitSnapshot(created) } });
    return created;
  }
  async updateProfitVersion(versionId: string, input: ProfitVersionInput, operatorId?: string) {
    const before = await this.prisma.serviceProfitVersion.findUnique({ where: { id: versionId }, include: { rows: true } }); if (!before) throw new NotFoundException('利润版本不存在');
    if (input.serviceId !== before.serviceId) throw new BadRequestException('利润版本不能直接转移到其他服务；请在目标服务新建版本');
    const normalized = await this.normalizeProfitVersion(input, versionId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.serviceProfitVersion.update({ where: { id: versionId }, data: { versionNo: normalized.versionNo, scope: normalized.scope, scopeTargetId: normalized.scopeTargetId, sourceCostVersionId: normalized.sourceCostVersionId, defaultMode: normalized.defaultMode, defaultValue: normalized.defaultValue, currency: normalized.currency, status: normalized.status, effectiveFrom: normalized.effectiveFrom, effectiveTo: normalized.effectiveTo, rows: { deleteMany: {}, create: normalized.rows } }, include: { rows: true } });
      await tx.profitVersionChangeLog.create({ data: { versionId, changedById: operatorId, beforeSnapshot: this.profitSnapshot(before), afterSnapshot: this.profitSnapshot(updated) } }); return updated;
    });
  }
  async setProfitVersionStatus(versionId: string, status: PriceVersionStatus, operatorId?: string) {
    const before = await this.prisma.serviceProfitVersion.findUnique({ where: { id: versionId }, include: { rows: true } }); if (!before) throw new NotFoundException('利润版本不存在');
    if (status === PriceVersionStatus.ACTIVE || status === PriceVersionStatus.SCHEDULED) await this.assertNoProfitOverlap(before.serviceId, before.scope, before.scopeTargetId, before.effectiveFrom, before.effectiveTo, versionId);
    const after = await this.prisma.serviceProfitVersion.update({ where: { id: versionId }, data: { status }, include: { rows: true } });
    await this.prisma.profitVersionChangeLog.create({ data: { versionId, changedById: operatorId, beforeSnapshot: this.profitSnapshot(before), afterSnapshot: this.profitSnapshot(after) } }); return after;
  }

  async profitMatrixExport(versionId: string) {
    const version = await this.prisma.serviceProfitVersion.findUnique({ where: { id: versionId }, include: { rows: true, sourceCostVersion: { include: { countries: { include: { country: true } }, rows: { include: { tiers: { orderBy: { minKg: 'asc' } } } } } } } });
    if (!version) throw new NotFoundException('利润版本不存在');
    const cost = version.sourceCostVersion; if (!cost) throw new BadRequestException('该利润版本尚未选择用于映射的成本表，无法导出矩阵');
    const columns = cost.rows; const countryNames = columns.map((column) => column.countryCode);
    const titles = columns.map((column) => `${cost.countries.find((country) => country.countryCode === column.countryCode)?.country.chineseName ?? column.countryCode}${columns.filter((item) => item.countryCode === column.countryCode).length > 1 ? `（${column.postcodeRuleStart || '默认'}）` : ''}`);
    const tierKeys = [...new Map(columns.flatMap((column) => column.tiers.map((tier) => [`${tier.minKg.toString()}|${tier.maxKg.toString()}|${tier.billingUnit}`, tier]))).entries()];
    const calculated = (base: Prisma.Decimal, countryCode: string) => { const rule = version.rows.find((row) => row.countryCode === countryCode) ?? { mode: version.defaultMode, value: version.defaultValue }; return rule.mode === ProfitMode.PERCENT_OF_COST ? base.mul(new Prisma.Decimal(1).plus(new Prisma.Decimal(rule.value).div(100))).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4) : base.plus(rule.value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4); };
    const spreadsheetRows: Array<Array<string>> = [['重量段', '计价单位', ...titles]];
    for (const [, tier] of tierKeys) { const current = tier!; spreadsheetRows.push([`${current.minKg.toString()}-${current.maxKg.greaterThanOrEqualTo('999999') ? '不限' : current.maxKg.toString()}`, current.billingUnit === CostBillingUnit.PER_SHIPMENT ? '按票' : current.billingUnit === CostBillingUnit.PER_BOX ? '按箱' : '每KG', ...columns.map((column) => { const matched = column.tiers.find((item) => item.minKg.equals(current.minKg) && item.maxKg.equals(current.maxKg) && item.billingUnit === current.billingUnit); return matched ? calculated(matched.fixedAmount, column.countryCode) : '—'; })]);
    }
    const rule = (countryCode: string) => version.rows.find((row) => row.countryCode === countryCode) ?? { mode: version.defaultMode, value: version.defaultValue };
    spreadsheetRows.push(['利润方式', '', ...countryNames.map((countryCode) => rule(countryCode).mode === ProfitMode.PERCENT_OF_COST ? '成本百分比' : '固定加价')]);
    spreadsheetRows.push(['利润值', '', ...countryNames.map((countryCode) => rule(countryCode).value.toString())]);
    const worksheet = XLSX.utils.aoa_to_sheet(spreadsheetRows); const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, '利润价格矩阵');
    return { filename: `${version.versionNo}-利润价格表.xlsx`, content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer };
  }

  private async normalizeProfitVersion(input: ProfitVersionInput, excludeVersionId?: string) {
    const start = new Date(input.effectiveFrom); const end = input.effectiveTo ? new Date(input.effectiveTo) : null; const scope = input.scope ?? ProfitScope.DEFAULT; const status = input.status ?? PriceVersionStatus.ACTIVE; const targetId = scope === ProfitScope.DEFAULT ? null : input.scopeTargetId?.trim() || null;
    const rows = input.rows ?? []; const defaultMode = input.defaultMode ?? ProfitMode.FIXED_AMOUNT; const defaultValue = input.defaultValue ?? '0';
    this.validateDates(start, end); this.validateProfitRows(rows); this.decimal(defaultValue, '默认利润值');
    if (!input.versionNo?.trim()) throw new BadRequestException('利润版本号不能为空');
    const service = await this.prisma.service.findUnique({ where: { id: input.serviceId }, select: { id: true, supplierId: true } }); if (!service) throw new NotFoundException('服务不存在');
    const sourceCostVersionId = input.sourceCostVersionId?.trim() || null;
    if (sourceCostVersionId) { const cost = await this.prisma.supplierCostVersion.findFirst({ where: { id: sourceCostVersionId, supplierConnectionId: service.supplierId }, select: { id: true } }); if (!cost) throw new BadRequestException('利润映射成本表不存在，或不属于该服务的供应商连接'); }
    await this.assertProfitTarget(scope, targetId);
    if (status === PriceVersionStatus.ACTIVE || status === PriceVersionStatus.SCHEDULED) await this.assertNoProfitOverlap(input.serviceId, scope, targetId, start, end, excludeVersionId);
    return { serviceId: input.serviceId, versionNo: input.versionNo.trim(), scope, scopeTargetId: targetId, sourceCostVersionId, defaultMode, defaultValue, currency: input.currency, status, effectiveFrom: start, effectiveTo: end, rows: rows.map((row) => ({ countryCode: row.countryCode.trim().toUpperCase(), mode: row.mode, value: row.value })) };
  }

  private async assertProfitTarget(scope: ProfitScope, targetId: string | null) {
    if (scope === ProfitScope.DEFAULT) { if (targetId) throw new BadRequestException('默认报价不能指定适用对象'); return; }
    if (!targetId) throw new BadRequestException('该利润范围必须选择适用对象');
    const valid = scope === ProfitScope.SPECIFIC_CUSTOMER
      ? await this.prisma.customer.findUnique({ where: { id: targetId }, select: { id: true } })
      : scope === ProfitScope.CUSTOMER_LEVEL
        ? await this.prisma.customerLevel.findUnique({ where: { id: targetId }, select: { id: true } })
        : await this.prisma.customerGroup.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!valid) throw new BadRequestException('利润报价适用对象不存在');
  }

  private async resolveProfitVersion(customerId: string, serviceId: string, countryCode: string, at: Date, serviceCode: string) {
    const [levelAssignment, groupAssignment] = await Promise.all([
      this.prisma.customerLevelAssignment.findFirst({ where: { customerId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }, orderBy: { effectiveFrom: 'desc' } }),
      this.prisma.customerGroupAssignment.findFirst({ where: { customerId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }, orderBy: { effectiveFrom: 'desc' } }),
    ]);
    const scopes: Array<{ scope: ProfitScope; targetId: string | null; label: string }> = [
      { scope: ProfitScope.SPECIFIC_CUSTOMER, targetId: customerId, label: '指定客户' },
      ...(groupAssignment ? [{ scope: ProfitScope.CUSTOMER_GROUP, targetId: groupAssignment.customerGroupId, label: '客户分组' }] : []),
      ...(levelAssignment ? [{ scope: ProfitScope.CUSTOMER_LEVEL, targetId: levelAssignment.customerLevelId, label: '客户等级' }] : []),
      { scope: ProfitScope.DEFAULT, targetId: null, label: '默认报价' },
    ];
    for (const candidate of scopes) {
      const versions = await this.prisma.serviceProfitVersion.findMany({ where: { serviceId, scope: candidate.scope, scopeTargetId: candidate.targetId, status: { in: [PriceVersionStatus.ACTIVE, PriceVersionStatus.SCHEDULED] }, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }, include: { rows: true } });
      if (versions.length > 1) throw new ConflictException(`服务 ${serviceCode} 的${candidate.label}存在多个生效利润版本，请先修正有效期`);
      const version = versions[0]; if (!version) continue;
      const row = version.rows.find((item) => item.countryCode === countryCode) ?? { countryCode, mode: version.defaultMode, value: version.defaultValue };
      return { version, row };
    }
    throw new NotFoundException(`服务 ${serviceCode} 在 ${countryCode} 暂无生效利润报价`);
  }

  private profitSnapshot(value: { id: string; serviceId: string; versionNo: string; scope: ProfitScope; scopeTargetId: string | null; sourceCostVersionId?: string | null; defaultMode?: ProfitMode; defaultValue?: { toString(): string }; currency: unknown; status: PriceVersionStatus; effectiveFrom: Date; effectiveTo: Date | null; rows: Array<{ countryCode: string; mode: ProfitMode; value: { toString(): string } }> }) {
    return { id: value.id, serviceId: value.serviceId, versionNo: value.versionNo, scope: value.scope, scopeTargetId: value.scopeTargetId, sourceCostVersionId: value.sourceCostVersionId ?? null, defaultMode: value.defaultMode ?? ProfitMode.FIXED_AMOUNT, defaultValue: value.defaultValue?.toString() ?? '0', currency: String(value.currency), status: value.status, effectiveFrom: value.effectiveFrom.toISOString(), effectiveTo: value.effectiveTo?.toISOString() ?? null, rows: value.rows.map((row) => ({ countryCode: row.countryCode, mode: row.mode, value: row.value.toString() })) } as Prisma.InputJsonValue;
  }

  private async parseGrid(table: Awaited<ReturnType<PricingService['costTable']>>, pastedText: string): Promise<ParsedGrid> {
    const rows = pastedText.replace(/\r/g, '').trim().split('\n').filter(Boolean).map((line) => line.split('\t').map((cell) => cell.trim())); if (rows.length < 7) throw new BadRequestException('请粘贴重量价格、邮编开头和四项费用完整区域'); const header = rows[0]!; if (header[0] !== '重量段' || header[1] !== '计价单位' || header.length < 3) throw new BadRequestException('模板首行必须为“重量段、计价单位、国家列”'); if (rows.some((row) => row.length !== header.length)) throw new BadRequestException('Excel 存在列数与表头不一致的行');
    const marker = rows.findIndex((row, index) => index > 0 && row[0] === '邮编开头'); if (marker < 2) throw new BadRequestException('重量价格后必须有“邮编开头”行'); const controlRows = rows.slice(marker); const controls = new Map(controlRows.map((row) => [row[0], row])); for (const label of ['邮编开头', '最低票运费', '最低箱运费', '挂号费', '操作费']) if (!controls.has(label)) throw new BadRequestException(`模板缺少“${label}”行`); if (controlRows.length !== 5 || controls.size !== 5) throw new BadRequestException('邮编开头之后只允许最低票运费、最低箱运费、挂号费、操作费四行');
    const countries = await this.resolveCountryTokens(header.slice(2), 'Excel 国家列', true); const expected = new Set(table.countries.map((item) => item.countryCode)); const actual = new Set(countries.map((item) => item.code)); if (expected.size !== actual.size || [...expected].some((code) => !actual.has(code))) throw new BadRequestException('Excel 国家列必须覆盖且只能使用成本表国家组'); const rules = rows.slice(1, marker).map((row, index) => ({ ...this.parseRange(row[0]!, index + 2), billingUnit: this.parseUnit(row[1]!, index + 2) }));
    for (let index = 0; index < rules.length; index += 1) { const current = rules[index]!; const previous = rules[index - 1]; if (previous && (previous.maxKg === undefined || new Prisma.Decimal(current.minKg).lessThanOrEqualTo(previous.maxKg))) throw new BadRequestException('重量段必须从小到大且不能重叠'); if (current.maxKg === undefined && index !== rules.length - 1) throw new BadRequestException('开放上限重量段只能位于最后一行'); }
    const postcodeRow = controls.get('邮编开头')!; const shipmentRow = controls.get('最低票运费')!; const boxRow = controls.get('最低箱运费')!; const registrationRow = controls.get('挂号费')!; const operationRow = controls.get('操作费')!; const columns = countries.map((country, index) => { const column = index + 2; return { countryCode: country.code, ...this.parsePostcodeRule(postcodeRow[column]!), minimumPerShipment: this.nonNegative(shipmentRow[column]!, `${country.code} 最低票运费`), minimumPerBox: this.nonNegative(boxRow[column]!, `${country.code} 最低箱运费`), registrationFee: this.nonNegative(registrationRow[column]!, `${country.code} 挂号费`, 2, '票'), operationFeePerKg: this.nonNegative(operationRow[column]!, `${country.code} 操作费`, 4, 'KG'), prices: rows.slice(1, marker).map((row, rowIndex) => this.nonNegative(row[column]!, `第 ${rowIndex + 2} 行 ${country.code} 价格`, 4)) }; }); this.assertPostcodeRules(columns); return { rules, columns };
  }

  private costMatrixRows(table: Awaited<ReturnType<PricingService['costTable']>>): string[][] {
    const columns = [...table.rows].sort((left, right) => `${left.countryCode}|${left.postcodeRuleType}|${left.postcodeRuleStart}`.localeCompare(`${right.countryCode}|${right.postcodeRuleType}|${right.postcodeRuleStart}`));
    const countryNames = new Map(table.countries.map((country) => [country.countryCode, country.country.chineseName]));
    const tierMap = new Map<string, (typeof columns)[number]['tiers'][number]>();
    for (const column of columns) for (const tier of column.tiers) tierMap.set(`${tier.minKg.toString()}|${tier.maxKg.toString()}|${tier.billingUnit}`, tier);
    const tiers = [...tierMap.values()].sort((left, right) => left.minKg.comparedTo(right.minKg) || left.maxKg.comparedTo(right.maxKg));
    const valueAt = (column: (typeof columns)[number], tier: (typeof tiers)[number]) => column.tiers.find((item) => item.minKg.equals(tier.minKg) && item.maxKg.equals(tier.maxKg) && item.billingUnit === tier.billingUnit)?.fixedAmount.toString() ?? '';
    const unit = (value: CostBillingUnit) => value === CostBillingUnit.PER_SHIPMENT ? '按票' : value === CostBillingUnit.PER_BOX ? '按箱' : '每KG';
    const range = (tier: (typeof tiers)[number]) => tier.maxKg.greaterThanOrEqualTo('999999') ? `${tier.minKg.toString()}+` : `${tier.minKg.toString()}-${tier.maxKg.toString()}`;
    const postcode = (column: (typeof columns)[number]) => column.postcodeRuleType === CostPostcodeRuleType.DEFAULT ? '' : column.postcodeRuleType === CostPostcodeRuleType.EXACT ? column.postcodeRuleStart : `${column.postcodeRuleStart}-${column.postcodeRuleEnd}`;
    return [
      ['重量段', '计价单位', ...columns.map((column) => countryNames.get(column.countryCode) ?? column.countryCode)],
      ...tiers.map((tier) => [range(tier), unit(tier.billingUnit), ...columns.map((column) => valueAt(column, tier))]),
      ['邮编开头', '', ...columns.map(postcode)],
      ['最低票运费', '', ...columns.map((column) => column.minimumPerShipment.toString())],
      ['最低箱运费', '', ...columns.map((column) => column.minimumPerBox.toString())],
      ['挂号费', '', ...columns.map((column) => `${column.registrationFee.toString()}/票`)],
      ['操作费', '', ...columns.map((column) => `${column.operationFeePerKg.toString()}/KG`)],
    ];
  }

  private matchPriceColumn<T extends { countryCode: string; postcodeRuleType: CostPostcodeRuleType; postcodeRuleStart: string; postcodeRuleEnd: string | null }>(rows: T[], postcode: string | undefined, countryCode: string, versionNo: string): T { const normalized = this.normalizePostcode(postcode); const specific = rows.filter((row) => row.postcodeRuleType === CostPostcodeRuleType.EXACT ? Boolean(normalized) && normalized === row.postcodeRuleStart : row.postcodeRuleType === CostPostcodeRuleType.NUMERIC_RANGE ? this.inNumericRange(normalized, row.postcodeRuleStart, row.postcodeRuleEnd!) : false); if (specific.length > 1) throw new ConflictException(`成本表 ${versionNo} 的 ${countryCode} 邮编 ${normalized || '空'} 命中多个具体价格列`); if (specific.length === 1) return specific[0]!; const defaults = rows.filter((row) => row.postcodeRuleType === CostPostcodeRuleType.DEFAULT); if (defaults.length > 1) throw new ConflictException(`成本表 ${versionNo} 的 ${countryCode} 存在多个默认价格列`); if (defaults.length === 1) return defaults[0]!; throw new NotFoundException(`成本表 ${versionNo} 的 ${countryCode} 邮编 ${normalized || '空'} 暂无可用成本价格`); }
  private normalizeHeader(input: CostTableInput) { if (!input.effectiveTo?.trim()) throw new BadRequestException('成本表必须填写生效结束时间'); const start = new Date(input.effectiveFrom); const end = new Date(input.effectiveTo); const minWeight = this.decimal(input.minWeightKg, '最小重量'); const maxWeight = input.maxWeightKg ? this.decimal(input.maxWeightKg, '最大重量') : null; const minBoxes = Number(input.minBoxes); const maxBoxes = input.maxBoxes === undefined || input.maxBoxes === null ? null : Number(input.maxBoxes); if (!input.versionNo.trim() || minWeight.lessThan(0) || (maxWeight && maxWeight.lessThan(minWeight)) || !Number.isInteger(minBoxes) || minBoxes < 1 || (maxBoxes !== null && (!Number.isInteger(maxBoxes) || maxBoxes < minBoxes))) throw new BadRequestException('成本表版本或适用范围无效'); this.validateDates(start, end); return { start, end, minWeight, maxWeight, minBoxes, maxBoxes }; }
  private parseRange(value: string, rowNo: number) { if (/^0\s*\+$/u.test(value)) return { minKg: '0', maxKg: '1' }; const bounded = value.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/); const open = value.match(/^(\d+(?:\.\d+)?)\s*\+$/); if (bounded) { if (new Prisma.Decimal(bounded[2]!).lessThan(new Prisma.Decimal(bounded[1]!))) throw new BadRequestException(`第 ${rowNo} 行重量段无效`); return { minKg: bounded[1]!, maxKg: bounded[2]! }; } if (open) return { minKg: open[1]!, maxKg: undefined }; throw new BadRequestException(`第 ${rowNo} 行重量段格式无效，应为 0-1、1.01-2 或 71.01+`); }
  private parseUnit(value: string, rowNo: number) { const map: Record<string, CostBillingUnit> = { '按票': CostBillingUnit.PER_SHIPMENT, '按箱': CostBillingUnit.PER_BOX, '每KG': CostBillingUnit.PER_KG, '每kg': CostBillingUnit.PER_KG }; const unit = map[value]; if (!unit) throw new BadRequestException(`第 ${rowNo} 行计价单位必须为“按票”“按箱”或“每KG”`); return unit; }
  private parsePostcodeRule(value: string) { const normalized = this.normalizePostcode(value); if (!normalized) return { postcodeRuleType: CostPostcodeRuleType.DEFAULT, postcodeRuleStart: '', postcodeRuleEnd: undefined }; const range = normalized.match(/^(\d+)-(\d+)$/); if (range) { if (range[1]!.length !== range[2]!.length || BigInt(range[1]!) > BigInt(range[2]!)) throw new BadRequestException(`邮编区间“${value}”无效`); return { postcodeRuleType: CostPostcodeRuleType.NUMERIC_RANGE, postcodeRuleStart: range[1]!, postcodeRuleEnd: range[2]! }; } return { postcodeRuleType: CostPostcodeRuleType.EXACT, postcodeRuleStart: normalized, postcodeRuleEnd: undefined }; }
  private assertPostcodeRules(columns: PriceColumn[]) { for (const country of new Set(columns.map((column) => column.countryCode))) { const rules = columns.filter((column) => column.countryCode === country); if (rules.filter((row) => row.postcodeRuleType === CostPostcodeRuleType.DEFAULT).length > 1) throw new BadRequestException(`${country} 只能有一个默认价格列`); for (let left = 0; left < rules.length; left += 1) for (let right = left + 1; right < rules.length; right += 1) if (this.rulesOverlap(rules[left]!, rules[right]!)) throw new BadRequestException(`${country} 存在重叠或重复的邮编价格规则`); } }
  private rulesOverlap(left: PriceColumn, right: PriceColumn) { if (left.postcodeRuleType === CostPostcodeRuleType.DEFAULT || right.postcodeRuleType === CostPostcodeRuleType.DEFAULT) return false; if (left.postcodeRuleType === CostPostcodeRuleType.EXACT && right.postcodeRuleType === CostPostcodeRuleType.EXACT) return left.postcodeRuleStart === right.postcodeRuleStart; if (left.postcodeRuleType === CostPostcodeRuleType.NUMERIC_RANGE && right.postcodeRuleType === CostPostcodeRuleType.NUMERIC_RANGE) return left.postcodeRuleStart.length === right.postcodeRuleStart.length && BigInt(left.postcodeRuleStart) <= BigInt(right.postcodeRuleEnd!) && BigInt(right.postcodeRuleStart) <= BigInt(left.postcodeRuleEnd!); const exact = left.postcodeRuleType === CostPostcodeRuleType.EXACT ? left : right; const range = exact === left ? right : left; return /^\d+$/u.test(exact.postcodeRuleStart) && this.inNumericRange(exact.postcodeRuleStart, range.postcodeRuleStart, range.postcodeRuleEnd!); }
  private inNumericRange(value: string, start: string, end: string) { return /^\d+$/u.test(value) && value.length === start.length && BigInt(value) >= BigInt(start) && BigInt(value) <= BigInt(end); }
  private normalizePostcode(value?: string) { return (value ?? '').trim().toUpperCase().replace(/\s+/g, ''); }
  private nonNegative(value: string, label: string, scale = 2, unit?: '票' | 'KG') { const normalized = value.trim().replace(/\s+/g, ''); const pattern = unit ? new RegExp(`^(\\d+(?:\\.\\d+)?)(?:/${unit})?$`, 'i') : /^(\d+(?:\.\d+)?)$/; const found = normalized.match(pattern); if (!found) throw new BadRequestException(`${label}必须是非负数字${unit ? `或数字/${unit}` : ''}`); return this.decimal(found[1]!, label).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP).toFixed(scale); }
  private async resolveCountries(text: string) { return this.resolveCountryTokens(text.trim().split(/\s+/).filter(Boolean), '国家组'); }
  private async resolveCountryTokens(tokens: string[], fieldName: string, allowDuplicates = false) { if (!tokens.length) throw new BadRequestException(`${fieldName}至少需要一个国家`); const countries = await this.prisma.country.findMany({ where: { enabled: true } }); const byToken = new Map(countries.flatMap((country) => [[country.code.toUpperCase(), country], [country.chineseName, country]])); const output = tokens.map((token) => byToken.get(token.toUpperCase()) ?? byToken.get(token)); if (output.some((country) => !country)) throw new BadRequestException(`${fieldName}包含未知或已停用国家，请先在国家表中维护`); const resolved = output as typeof countries; if (!allowDuplicates && new Set(resolved.map((country) => country.code)).size !== resolved.length) throw new BadRequestException(`${fieldName}包含重复国家`); return resolved; }
  private decimal(value: string, label: string) { if (!Number.isFinite(Number(value))) throw new BadRequestException(`${label}必须是有效数字`); return new Prisma.Decimal(value); }
  private validateDates(start: Date, end: Date | null) { if (Number.isNaN(start.valueOf()) || (end && Number.isNaN(end.valueOf())) || (end && end <= start)) throw new BadRequestException('生效时间区间无效'); }
  private validateProfitRows(rows: ProfitRow[]) { const countries = new Set<string>(); for (const row of rows) { const country = row.countryCode?.trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(country) || !Number.isFinite(Number(row.value))) throw new BadRequestException('国家例外利润规则无效'); if (countries.has(country)) throw new BadRequestException(`国家 ${country} 存在重复的利润例外规则`); countries.add(country); } }
  private async assertNoCostTableOverlap(supplierId: string, countryCodes: string[], header: ReturnType<PricingService['normalizeHeader']>, excludeTableId?: string) { const candidates = await this.prisma.supplierCostVersion.findMany({ where: { ...(excludeTableId ? { id: { not: excludeTableId } } : {}), supplierConnectionId: supplierId, status: { in: [PriceVersionStatus.ACTIVE, PriceVersionStatus.SCHEDULED] }, effectiveFrom: { lte: header.end ?? new Date('9999-12-31') }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: header.start } }], countries: { some: { countryCode: { in: countryCodes } } } } }); const overlaps = (minA: Prisma.Decimal, maxA: Prisma.Decimal | null, minB: Prisma.Decimal, maxB: Prisma.Decimal | null) => minA.lessThanOrEqualTo(maxB ?? new Prisma.Decimal('999999999')) && minB.lessThanOrEqualTo(maxA ?? new Prisma.Decimal('999999999')); if (candidates.some((item) => overlaps(header.minWeight, header.maxWeight, item.minWeightKg, item.maxWeightKg) && overlaps(new Prisma.Decimal(header.minBoxes), header.maxBoxes === null ? null : new Prisma.Decimal(header.maxBoxes), new Prisma.Decimal(item.minBoxes), item.maxBoxes === null ? null : new Prisma.Decimal(item.maxBoxes)))) throw new ConflictException('与已有成本表的国家、重量、箱数或生效期范围重叠'); }
  private async assertNoProfitOverlap(serviceId: string, scope: ProfitScope, target: string | null, start: Date, end: Date | null, excludeVersionId?: string) { const found = await this.prisma.serviceProfitVersion.findFirst({ where: { ...(excludeVersionId ? { id: { not: excludeVersionId } } : {}), serviceId, scope, scopeTargetId: target, status: { in: [PriceVersionStatus.ACTIVE, PriceVersionStatus.SCHEDULED] }, effectiveFrom: { lte: end ?? new Date('9999-12-31') }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] } }); if (found) throw new ConflictException(`与利润表版本 ${found.versionNo} 的生效时间重叠`); }
}
