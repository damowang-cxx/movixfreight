import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActualDataSource, BillingMethod, ChannelEnvironment, Currency, MeasurementMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FedexRelayConfig } from '../connectors/fedex-relay.config';
import { connectorDrivers, fedexRoutePreset, getConnectorDriver, normalizeBusinessConfig, normalizeRouteFieldConfig, routeFieldSchema } from '../connectors/connector-drivers.registry';

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
    const value = await this.prisma.supplier.findUnique({ where: { id }, include: { carrier: true, services: { select: { id: true, code: true, name: true, enabled: true, carrierServiceType: true } }, countryRoutes: { include: { countries: true, service: { select: { id: true, code: true, name: true, enabled: true } } }, orderBy: { createdAt: 'asc' } }, costVersions: { select: { id: true, versionNo: true, status: true } }, billImportBatches: { select: { id: true, originalFilename: true, createdAt: true }, take: 5, orderBy: { createdAt: 'desc' } } } });
    if (!value) throw new NotFoundException('供应商连接不存在');
    const enabledServices = value.services.filter((service) => service.enabled);
    const unifiedPricingService = value.driverCode === 'FEDEX_RELAY'
      ? { status: enabledServices.length === 1 ? 'READY' : enabledServices.length === 0 ? 'MISSING' : 'MULTIPLE', enabledServiceCount: enabledServices.length, service: enabledServices.length === 1 ? enabledServices[0] : null }
      : undefined;
    return { ...value, unifiedPricingService, credentialStatus: value.driverCode === 'FEDEX_RELAY' ? this.fedexConfig.status(value.code, value.environment === ChannelEnvironment.PRODUCTION) : undefined };
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
  async createSupplierRoute(supplierId: string, data: { code: string; name: string; routeType: string; serviceId?: string; carrierServiceType?: string; countryCodes: string[]; customsMode?: string; fieldConfig?: Record<string, unknown>; enabled?: boolean }) {
    return this.saveSupplierRoute(supplierId, data);
  }
  async updateSupplierRoute(supplierId: string, routeId: string, data: { code: string; name: string; routeType: string; serviceId?: string; carrierServiceType?: string; countryCodes: string[]; customsMode?: string; fieldConfig?: Record<string, unknown>; enabled?: boolean }) {
    const route = await this.prisma.supplierCountryRoute.findFirst({ where: { id: routeId, supplierId }, select: { id: true, fieldConfig: true, enabled: true } });
    if (!route) throw new NotFoundException('供应商国家路由不存在');
    return this.saveSupplierRoute(supplierId, { ...data, fieldConfig: data.fieldConfig ?? route.fieldConfig as Record<string, unknown>, enabled: data.enabled ?? route.enabled }, routeId);
  }
  async deleteSupplierRoute(supplierId: string, routeId: string) {
    const route = await this.prisma.supplierCountryRoute.findFirst({ where: { id: routeId, supplierId }, include: { _count: { select: { orders: true } } } });
    if (!route) throw new NotFoundException('供应商国家路由不存在');
    if (route._count.orders) throw new ConflictException('该路由已有订单引用，不能删除；请停用');
    await this.prisma.supplierCountryRoute.delete({ where: { id: routeId } }); return { deleted: true };
  }
  async orderableSuppliers(allowSandbox: boolean) {
    const suppliers = await this.prisma.supplier.findMany({ where: { enabled: true, carrier: { enabled: true }, ...(allowSandbox ? {} : { environment: ChannelEnvironment.PRODUCTION }) }, include: { carrier: { select: { code: true, name: true } }, services: { where: { enabled: true }, select: { id: true } }, countryRoutes: { where: { enabled: true }, include: { countries: true }, orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'desc' } });
    // 供应商是用户的第一层选择；国家路由仅在目的国填写后自动解析。
    // 不能因为尚未配置路由就隐藏供应商，否则管理员无法看出需要补充哪条线路。
    return suppliers.map((supplier) => {
      const unifiedPricingStatus = supplier.driverCode === 'FEDEX_RELAY' ? (supplier.services.length === 1 ? 'READY' : supplier.services.length === 0 ? 'MISSING' : 'MULTIPLE') : undefined;
      return { id: supplier.id, code: supplier.code, name: supplier.name, environment: supplier.environment, driverCode: supplier.driverCode, carrier: supplier.carrier, countries: [...new Set(supplier.countryRoutes.flatMap((route) => route.countries.map((country) => country.countryCode)))].sort(), hasCountryRoutes: supplier.countryRoutes.length > 0, unifiedPricingStatus };
    });
  }
  async resolveOrderRoute(supplierId: string, countryInput: string, allowSandbox: boolean) {
    const countryCode = await this.resolveCountryCode(countryInput);
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, enabled: true, carrier: { enabled: true }, ...(allowSandbox ? {} : { environment: ChannelEnvironment.PRODUCTION }) }, include: { carrier: true, services: { where: { enabled: true }, select: { id: true, code: true, name: true, currency: true, measurementMethod: true, allowsMultiPiece: true, minPieces: true } }, countryRoutes: { where: { enabled: true, countries: { some: { countryCode } } }, include: { countries: true, service: true } } } });
    if (!supplier) throw new NotFoundException('供应商不存在、已停用或当前环境不可下单');
    const unifiedService = this.resolveFedexUnifiedService(supplier.driverCode, supplier.services);
    if (supplier.countryRoutes.length !== 1) throw new ConflictException(supplier.countryRoutes.length ? `供应商 ${supplier.name} 在 ${countryCode} 存在多个可用国家路由，请修正路由配置` : `供应商 ${supplier.name} 暂未配置 ${countryCode} 的国家路由`);
    const route = supplier.countryRoutes[0]!;
    if (!route.service.enabled) throw new ConflictException('命中国家路由绑定的内部计价服务已停用');
    if (route.service.supplierId !== supplier.id) throw new ConflictException('国家路由绑定的内部计价服务不属于当前供应商');
    if (unifiedService && route.serviceId !== unifiedService.id) throw new ConflictException('FedEx 国家路由未绑定供应商唯一的统一计价服务，请在供应商详情重新保存路由');
    return { supplier: { id: supplier.id, code: supplier.code, name: supplier.name, environment: supplier.environment, driverCode: supplier.driverCode, carrier: supplier.carrier }, route: { id: route.id, code: route.code, name: route.name, routeType: route.routeType, carrierServiceType: route.carrierServiceType, countryCodes: route.countries.map((item) => item.countryCode), fieldSchema: routeFieldSchema(supplier.driverCode, route.customsMode, route.fieldConfig as Record<string, unknown>, route.routeType) }, service: { id: route.service.id, code: route.service.code, name: route.service.name, currency: route.service.currency, measurementMethod: route.service.measurementMethod, allowsMultiPiece: route.service.allowsMultiPiece, minPieces: route.service.minPieces } };
  }
  private async saveSupplierRoute(supplierId: string, data: { code: string; name: string; routeType: string; serviceId?: string; carrierServiceType?: string; countryCodes: string[]; customsMode?: string; fieldConfig?: Record<string, unknown>; enabled?: boolean }, routeId?: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, driverCode: true } }); if (!supplier) throw new NotFoundException('供应商连接不存在');
    const enabledServices = await this.prisma.service.findMany({ where: { supplierId, enabled: true }, select: { id: true, code: true, name: true } });
    const unifiedService = this.resolveFedexUnifiedService(supplier.driverCode, enabledServices);
    const serviceId = unifiedService?.id ?? data.serviceId;
    if (!serviceId) throw new BadRequestException('请为国家路由选择内部计价服务');
    if (unifiedService && data.serviceId && data.serviceId !== unifiedService.id) throw new BadRequestException('FedEx 国家路由必须自动使用供应商唯一的统一计价服务');
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, supplierId }, select: { id: true } }); if (!service) throw new BadRequestException('内部计价服务不存在或不属于当前供应商');
    const countries = [...new Set(data.countryCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))]; if (!countries.length) throw new BadRequestException('国家路由至少需要一个目的国');
    if (data.routeType === 'NL_DOMESTIC' && (countries.length !== 1 || countries[0] !== 'NL')) throw new BadRequestException('荷兰本土路由只能配置 NL');
    if (data.routeType === 'PAN_EUROPE' && countries.includes('NL')) throw new BadRequestException('泛欧路由不得包含 NL；请使用荷兰本土路由');
    const knownCountries = await this.prisma.country.findMany({ where: { code: { in: countries }, enabled: true }, select: { code: true } }); if (knownCountries.length !== countries.length) throw new BadRequestException('路由包含未知或已停用国家');
    const overlaps = await this.prisma.supplierCountryRoute.findMany({ where: { supplierId, ...(routeId ? { id: { not: routeId } } : {}), countries: { some: { countryCode: { in: countries } } } }, include: { countries: true } });
    if (overlaps.length) throw new ConflictException(`目的国已被路由 ${overlaps.map((item) => item.code).join('、')} 使用`);
    const fieldConfig = normalizeRouteFieldConfig(data.fieldConfig);
    if (supplier.driverCode === 'FEDEX_RELAY' && Array.isArray(fieldConfig.shipmentOptions) && fieldConfig.shipmentOptions.length > 0) {
      throw new BadRequestException('FedEx Relay 的税务、贸易条款、报关、清关和物品属性映射尚未在驱动中确认；当前国家路由不能启用这些字段');
    }
    const preset = supplier.driverCode === 'FEDEX_RELAY' ? fedexRoutePreset(data.routeType) : undefined;
    if (supplier.driverCode === 'FEDEX_RELAY' && !preset) throw new BadRequestException('FedEx Relay 仅支持荷兰本土或泛欧国家路由');
    if (preset && data.carrierServiceType?.trim() && data.carrierServiceType.trim().toUpperCase() !== preset.carrierServiceType) throw new BadRequestException(`${data.routeType} 路由的 FedEx serviceType 已固定为 ${preset.carrierServiceType}`);
    if (preset && data.customsMode && data.customsMode !== preset.customsMode) throw new BadRequestException(`${data.routeType} 路由的清关货品规则已固定为 ${preset.customsMode}`);
    const value = { code: data.code.trim().toUpperCase(), name: data.name.trim(), routeType: data.routeType, serviceId, carrierServiceType: preset?.carrierServiceType ?? data.carrierServiceType?.trim().toUpperCase() ?? '', customsMode: preset?.customsMode ?? (data.customsMode === 'COMMODITIES' ? 'COMMODITIES' : 'NONE'), fieldConfig: fieldConfig as Prisma.InputJsonValue, enabled: data.enabled ?? true, countries: { create: countries.map((countryCode) => ({ countryCode })) } };
    if (!value.code || !value.name || !value.carrierServiceType) throw new BadRequestException('路由编号、名称和承运商服务代码不能为空');
    if (!routeId) return this.prisma.supplierCountryRoute.create({ data: { supplierId, ...value }, include: { countries: true, service: true } });
    // SupplierCountryRouteCountry uses a composite primary key. Prisma does not expose
    // nested deleteMany for this relation, so replace the country set explicitly in one transaction.
    return this.prisma.$transaction(async (tx) => {
      await tx.supplierCountryRouteCountry.deleteMany({ where: { routeId } });
      return tx.supplierCountryRoute.update({ where: { id: routeId }, data: value, include: { countries: true, service: true } });
    });
  }
  private resolveFedexUnifiedService<T extends { id: string }>(driverCode: string, services: T[]): T | undefined {
    if (driverCode !== 'FEDEX_RELAY') return undefined;
    if (services.length === 0) throw new ConflictException('FedEx 供应商连接尚未建立启用的统一计价服务，无法配置国家路由或创建订单');
    if (services.length > 1) throw new ConflictException('FedEx 供应商连接存在多个启用服务；请停用或整理为一个统一计价服务后再配置国家路由或创建订单');
    return services[0];
  }
  private async resolveCountryCode(value: string) {
    const normalized = value.trim().toUpperCase();
    const country = await this.prisma.country.findFirst({ where: { enabled: true, OR: [{ code: normalized }, { chineseName: value.trim() }] }, select: { code: true } });
    if (!country) throw new BadRequestException(`无法识别或未启用的目的国：${value}`); return country.code;
  }
  services() { return this.prisma.service.findMany({ include: { supplier: { include: { carrier: true } }, remoteAreaTemplate: true }, orderBy: { createdAt: 'desc' } }); }
  customerServices() { return this.prisma.service.findMany({ where: { enabled: true, supplier: { enabled: true, environment: ChannelEnvironment.PRODUCTION, carrier: { enabled: true } } }, select: { id: true, code: true, name: true, currency: true, billingMethod: true, measurementMethod: true, allowsMultiPiece: true, minPieces: true, maxActualWeightKg: true, supplier: { select: { driverCode: true, environment: true, carrier: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' } }); }
  async createService(data: { code: string; name: string; supplierId: string; carrierServiceType?: string; currency: Currency; billingMethod: BillingMethod; measurementMethod: MeasurementMethod; volumetricDivisor?: string; maxActualWeightKg?: string; chargeableWeightScale?: number; allowsMultiPiece?: boolean; minPieces?: number; remoteFeeEnabled?: boolean; remoteFeeAmount?: string; remoteAreaTemplateId?: string }) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: data.supplierId, enabled: true, carrier: { enabled: true } } }); if (!supplier) throw new NotFoundException('可用供应商连接不存在');
    if (supplier.driverCode === 'FEDEX_RELAY' && await this.prisma.service.count({ where: { supplierId: supplier.id, enabled: true } })) throw new ConflictException('FedEx 供应商连接只能保留一个启用的统一计价服务；请直接维护现有服务，而不要新建第二个服务');
    if (data.billingMethod === BillingMethod.MAX_ACTUAL_OR_VOLUMETRIC && (!data.volumetricDivisor || Number(data.volumetricDivisor) <= 0)) throw new ConflictException('实重与材积重取大时必须设置大于 0 的计抛系数');
    const config = supplier.businessConfig as Record<string, unknown>; const modes = config.allowedServiceModes;
    if (Array.isArray(modes) && !modes.includes(data.allowsMultiPiece ? 'MULTI_PIECE' : 'SINGLE_ONLY')) throw new ConflictException('该供应商接口不允许所选件数模式');
    // 新订单的实际承运商 serviceType 由供应商国家路由维护；该字段仅保留给历史订单和未迁移数据兼容。
    return this.prisma.service.create({ data: { ...data, minPieces: data.minPieces ?? 1, chargeableWeightScale: data.chargeableWeightScale ?? 3, remoteFeeEnabled: data.remoteFeeEnabled ?? false } });
  }
  async setServiceEnabled(serviceId: string, enabled: boolean) {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId }, include: { supplier: { select: { id: true, driverCode: true } } } });
    if (!service) throw new NotFoundException('服务不存在');
    if (enabled && !service.enabled && service.supplier.driverCode === 'FEDEX_RELAY') {
      const existing = await this.prisma.service.count({ where: { supplierId: service.supplierId, enabled: true, id: { not: service.id } } });
      if (existing) throw new ConflictException('FedEx 供应商连接已有启用的统一计价服务；请先停用它，再启用此服务');
    }
    return this.prisma.service.update({ where: { id: serviceId }, data: { enabled } });
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
