import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActualDataSource, BillingMethod, ChannelEnvironment, Currency, MeasurementMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FedexRelayConfig } from '../connectors/fedex-relay.config';
import { connectorDrivers, getConnectorDriver, normalizeBusinessConfig } from '../connectors/connector-drivers.registry';

type SupplierInput = { carrierId: string; code: string; name: string; driverCode: string; environment: ChannelEnvironment; actualDataSource?: ActualDataSource; businessConfig?: Record<string, unknown> };

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly fedexConfig: FedexRelayConfig) {}

  connectorDrivers() { return connectorDrivers.map((driver) => ({ ...driver, credentialStatus: driver.code === 'FEDEX_RELAY' ? this.fedexConfig.status() : { configured: false } })); }
  fedexRelayStatus() { return this.fedexConfig.status(); }
  carriers() { return this.prisma.carrierChannel.findMany({ include: { _count: { select: { suppliers: true } } }, orderBy: { createdAt: 'desc' } }); }
  async createCarrier(name: string) {
    const value = name.trim(); if (!value) throw new ConflictException('渠道名称不能为空');
    const base = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CARRIER'; let code = base; let index = 2;
    while (await this.prisma.carrierChannel.findUnique({ where: { code } })) code = `${base}_${index++}`;
    try { return await this.prisma.carrierChannel.create({ data: { name: value, code } }); } catch { throw new ConflictException('渠道名称已存在'); }
  }
  async deleteCarrier(id: string) {
    const carrier = await this.prisma.carrierChannel.findUnique({ where: { id }, include: { _count: { select: { suppliers: true, costVersions: true, billImportBatches: true } } } });
    if (!carrier) throw new NotFoundException('尾程渠道不存在');
    const refs = Object.entries(carrier._count).filter(([, value]) => value > 0).map(([key]) => ({ suppliers: '供应商连接', costVersions: '成本表', billImportBatches: '账单批次' }[key]));
    if (refs.length) throw new ConflictException(`尾程渠道已被${refs.join('、')}引用，不能删除`);
    await this.prisma.carrierChannel.delete({ where: { id } });
    return { deleted: true };
  }
  async carrier(id: string) {
    const carrier = await this.prisma.carrierChannel.findUnique({ where: { id }, include: { suppliers: { include: { _count: { select: { services: true, costVersions: true, billImportBatches: true } } }, orderBy: { createdAt: 'desc' } }, fuelSurcharges: { orderBy: { effectiveFrom: 'desc' } } } });
    if (!carrier) throw new NotFoundException('尾程渠道不存在');
    return carrier;
  }
  async createCarrierFuelSurcharge(carrierId: string, data: { percent: string; effectiveFrom: string; effectiveTo: string }) {
    await this.carrier(carrierId);
    const percent = Number(data.percent); if (!Number.isFinite(percent) || percent < 0) throw new BadRequestException('燃油费率必须为非负数字');
    const effectiveFrom = this.parseFuelDate(data.effectiveFrom, false); const effectiveTo = this.parseFuelDate(data.effectiveTo, true);
    if (effectiveTo < effectiveFrom) throw new BadRequestException('燃油费结束日期不能早于生效日期');
    const overlap = await this.prisma.carrierFuelSurcharge.findFirst({ where: { carrierId, effectiveFrom: { lte: effectiveTo }, effectiveTo: { gte: effectiveFrom } }, select: { id: true } });
    if (overlap) throw new ConflictException('该渠道已有重叠的燃油费生效区间，请调整日期后保存');
    return this.prisma.carrierFuelSurcharge.create({ data: { carrierId, percent: data.percent, effectiveFrom, effectiveTo } });
  }
  async deleteCarrierFuelSurcharge(carrierId: string, surchargeId: string) {
    const surcharge = await this.prisma.carrierFuelSurcharge.findFirst({ where: { id: surchargeId, carrierId }, select: { id: true } });
    if (!surcharge) throw new NotFoundException('渠道燃油费记录不存在');
    await this.prisma.carrierFuelSurcharge.delete({ where: { id: surchargeId } });
    return { deleted: true };
  }
  suppliers() { return this.prisma.supplier.findMany({ include: { carrier: true, _count: { select: { services: true, billImportBatches: true, costVersions: true } } }, orderBy: { createdAt: 'desc' } }); }
  async supplier(id: string) {
    const value = await this.prisma.supplier.findUnique({ where: { id }, include: { carrier: true, services: { select: { id: true, code: true, name: true, enabled: true } }, costVersions: { select: { id: true, versionNo: true, status: true } }, billImportBatches: { select: { id: true, originalFilename: true, createdAt: true }, take: 5, orderBy: { createdAt: 'desc' } } } });
    if (!value) throw new NotFoundException('供应商连接不存在');
    return { ...value, credentialStatus: value.driverCode === 'FEDEX_RELAY' ? this.fedexConfig.status(value.code, value.environment === ChannelEnvironment.PRODUCTION) : undefined };
  }
  async createSupplier(data: SupplierInput) {
    const carrier = await this.prisma.carrierChannel.findFirst({ where: { id: data.carrierId, enabled: true } }); if (!carrier) throw new NotFoundException('尾程渠道不存在或已停用');
    const driver = getConnectorDriver(data.driverCode); if (!driver || !driver.carrierCodes.includes(carrier.code)) throw new ConflictException('所选接口不支持该尾程渠道');
    let businessConfig: Record<string, unknown>; try { businessConfig = normalizeBusinessConfig(driver, data.businessConfig); } catch (error) { throw new ConflictException(error instanceof Error ? error.message : '业务参数无效'); }
    const actualDataSource = (businessConfig.actualDataSource as ActualDataSource | undefined) ?? data.actualDataSource ?? ActualDataSource.BILL_EXCEL_IMPORT;
    try { return await this.prisma.supplier.create({ data: { carrierId: data.carrierId, code: data.code.trim().toUpperCase(), name: data.name.trim(), driverCode: data.driverCode, environment: data.environment, actualDataSource, businessConfig: businessConfig as Prisma.InputJsonValue, encryptedConfig: {} } }); } catch { throw new ConflictException('供应商编号已存在或参数无效'); }
  }
  async updateSupplier(id: string, data: Partial<Pick<SupplierInput, 'name' | 'environment' | 'actualDataSource' | 'businessConfig'>>) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } }); if (!supplier) throw new NotFoundException('供应商连接不存在'); const driver = getConnectorDriver(supplier.driverCode)!;
    let businessConfig: Record<string, unknown>; try { businessConfig = normalizeBusinessConfig(driver, data.businessConfig ?? supplier.businessConfig as Record<string, unknown>); } catch (error) { throw new ConflictException(error instanceof Error ? error.message : '业务参数无效'); }
    return this.prisma.supplier.update({ where: { id }, data: { name: data.name?.trim() || supplier.name, environment: data.environment ?? supplier.environment, actualDataSource: (businessConfig.actualDataSource as ActualDataSource | undefined) ?? data.actualDataSource ?? supplier.actualDataSource, businessConfig: businessConfig as Prisma.InputJsonValue } });
  }
  async setSupplierEnabled(id: string, enabled: boolean) { await this.supplier(id); return this.prisma.supplier.update({ where: { id }, data: { enabled } }); }
  async deleteSupplier(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id }, include: { _count: { select: { services: true, costVersions: true, billImportBatches: true } } } }); if (!supplier) throw new NotFoundException('供应商连接不存在');
    const refs = Object.entries(supplier._count).filter(([, value]) => value > 0).map(([key]) => ({ services: '服务', costVersions: '成本表', billImportBatches: '账单批次' }[key])); if (refs.length) throw new ConflictException(`供应商已被${refs.join('、')}引用，不能删除；请先停用`);
    await this.prisma.supplier.delete({ where: { id } }); return { deleted: true };
  }
  services() { return this.prisma.service.findMany({ include: { supplier: { include: { carrier: true } }, remoteAreaTemplate: true }, orderBy: { createdAt: 'desc' } }); }
  customerServices() { return this.prisma.service.findMany({ where: { enabled: true, supplier: { enabled: true, environment: ChannelEnvironment.PRODUCTION, carrier: { enabled: true } } }, select: { id: true, code: true, name: true, currency: true, billingMethod: true, measurementMethod: true, allowsMultiPiece: true, minPieces: true, maxActualWeightKg: true, supplier: { select: { driverCode: true, environment: true, carrier: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' } }); }
  async createService(data: { code: string; name: string; supplierId: string; carrierServiceType?: string; currency: Currency; billingMethod: BillingMethod; measurementMethod: MeasurementMethod; volumetricDivisor?: string; maxActualWeightKg?: string; chargeableWeightScale?: number; allowsMultiPiece?: boolean; minPieces?: number; remoteFeeEnabled?: boolean; remoteFeeAmount?: string; remoteAreaTemplateId?: string }) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: data.supplierId, enabled: true, carrier: { enabled: true } } }); if (!supplier) throw new NotFoundException('可用供应商连接不存在');
    if (data.billingMethod === BillingMethod.MAX_ACTUAL_OR_VOLUMETRIC && (!data.volumetricDivisor || Number(data.volumetricDivisor) <= 0)) throw new ConflictException('实重与材积重取大时必须设置大于 0 的计抛系数');
    const config = supplier.businessConfig as Record<string, unknown>; const modes = config.allowedServiceModes;
    if (Array.isArray(modes) && !modes.includes(data.allowsMultiPiece ? 'MULTI_PIECE' : 'SINGLE_ONLY')) throw new ConflictException('该供应商接口不允许所选件数模式');
    if (supplier.driverCode === 'FEDEX_RELAY' && !data.carrierServiceType) throw new ConflictException('FedEx 服务代码缺失');
    return this.prisma.service.create({ data: { ...data, minPieces: data.minPieces ?? 1, chargeableWeightScale: data.chargeableWeightScale ?? 3, remoteFeeEnabled: data.remoteFeeEnabled ?? false } });
  }
  remoteTemplates() { return this.prisma.remoteAreaTemplate.findMany({ include: { rules: true, _count: { select: { services: true } } }, orderBy: { createdAt: 'desc' } }); }
  async createRemoteTemplate(data: { code: string; name: string; description?: string; rules: { countryCode: string; ruleType: 'EXACT' | 'PREFIX'; ruleValue: string }[] }) { if (!data.rules.length) throw new ConflictException('偏远地址模板至少需要一条邮编规则'); return this.prisma.remoteAreaTemplate.create({ data: { code: data.code, name: data.name, description: data.description, rules: { create: data.rules.map((rule) => ({ ...rule, countryCode: rule.countryCode.toUpperCase(), ruleValue: rule.ruleValue.toUpperCase().replaceAll(' ', '') })) } }, include: { rules: true } }); }
  async updateServiceRemoteConfig(serviceId: string, data: { remoteFeeEnabled: boolean; remoteFeeAmount?: string; remoteAreaTemplateId?: string }) { if (data.remoteFeeEnabled && (!data.remoteFeeAmount || !data.remoteAreaTemplateId)) throw new ConflictException('启用偏远费时必须设置费用金额和偏远模板'); return this.prisma.service.update({ where: { id: serviceId }, data: { remoteFeeEnabled: data.remoteFeeEnabled, remoteFeeAmount: data.remoteFeeEnabled ? data.remoteFeeAmount : null, remoteAreaTemplateId: data.remoteFeeEnabled ? data.remoteAreaTemplateId : null } }); }
  private parseFuelDate(value: string, endOfDay: boolean) {
    const raw = value.trim(); const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : raw);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('燃油费生效日期无效');
    return date;
  }
}
