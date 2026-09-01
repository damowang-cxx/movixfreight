import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelEnvironment, CustomerStatus, FeeStatus, MeasurementMethod, Prisma, ShipmentStatus, WalletLedgerType } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { BalanceAlertsService } from '../balance-alerts/balance-alerts.service';
import { SettingsService, type DeclarationFieldCode } from '../settings/settings.service';
import { normalizeRecipientAddress } from './recipient-address';

export type ItemInput = { chineseName?: string; englishName?: string; material?: string; originCountryCode?: string; harmonizedCode?: string; quantity?: number; unitDeclaredValue?: string; declaredValueCurrency?: 'EUR' | 'GBP'; sku?: string; itemWeightKg?: string; itemLengthCm?: string; itemWidthCm?: string; itemHeightCm?: string };
export type BoxInput = { boxNo: string; reference?: string; weightKg: string; lengthCm: string; widthCm: string; heightCm: string; items: ItemInput[] };
export type CreateOrderInput = { idempotencyKey: string; serviceId: string; recipientName: string; recipientCompany?: string; recipientPhone?: string; recipientCountryCode: string; recipientPostcode: string; recipientCity: string; recipientAddress?: string; recipientAddressLine1?: string; recipientAddressLine2?: string; recipientAddressLine3?: string; recipientResidential?: boolean; estimatedChargeableKg: string; boxes: BoxInput[]; clientReference?: string; taxWith?: number; taxNumber?: string; deliveryWith?: string; exportWith?: number; importWith?: number; shipmentAttrs?: string[]; fromAddress?: Record<string, unknown>; toAddress?: Record<string, unknown> };
export type ImportOrderRow = { rowNo: number; customerId: string; order: Omit<CreateOrderInput, 'idempotencyKey'> };

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService, private readonly pricing: PricingService, private readonly balanceAlerts: BalanceAlertsService, private readonly settings: SettingsService) {}

  async createForCustomer(customerId: string, input: CreateOrderInput, options: { allowSandbox?: boolean } = {}) {
    if (!input.boxes.length) throw new BadRequestException('至少需要一个箱号');
    const recipientAddress = normalizeRecipientAddress(input.recipientAddress === undefined
      ? [input.recipientAddressLine1, input.recipientAddressLine2, input.recipientAddressLine3]
      : [input.recipientAddress]);
    const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) { if (existing.customerId !== customerId) throw new ConflictException('幂等键已被其他客户使用'); return existing; }
    const service = await this.prisma.service.findUnique({ where: { id: input.serviceId }, include: { supplier: true } });
    if (!service?.enabled || !service.supplier.enabled) throw new NotFoundException('服务不存在、已停用或供应商连接不可用');
    if (!options.allowSandbox && service.supplier.environment !== ChannelEnvironment.PRODUCTION) throw new ForbiddenException('普通客户仅可使用已启用的生产服务');
    await this.assertShipmentInput(input, service.supplier.driverCode);
    if (!service.allowsMultiPiece && input.boxes.length !== 1) throw new BadRequestException('该服务仅支持一票一件');
    if (input.boxes.length < service.minPieces) throw new BadRequestException('订单箱数低于服务最小件数');
    const quoteWeights = service.measurementMethod === MeasurementMethod.PER_SHIPMENT ? [input.estimatedChargeableKg] : input.boxes.map((box) => box.weightKg);
    const quote = await this.pricing.quote(customerId, input.serviceId, input.recipientCountryCode, quoteWeights, input.recipientPostcode, input.boxes);
    const precharge = new Prisma.Decimal(quote.total);
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, include: { wallets: true } });
      if (!customer) throw new NotFoundException('客户不存在');
      if (customer.status === CustomerStatus.FROZEN || customer.status === CustomerStatus.REJECTED || customer.status === CustomerStatus.PENDING_REVIEW || customer.status === CustomerStatus.PENDING_RECHARGE_VERIFICATION) throw new ForbiddenException('当前客户状态不可下单');
      const wallet = customer.wallets.find((item) => item.currency === quote.currency);
      if (!wallet || wallet.balance.lessThan(precharge) || wallet.balance.lessThan(0)) throw new ForbiddenException(`${quote.currency} 余额不足，无法创建订单`);
      const order = await tx.order.create({ data: { orderNo: this.number('ORD'), idempotencyKey: input.idempotencyKey, customerId, serviceId: input.serviceId, shipmentStatus: ShipmentStatus.SUBMITTED, feeStatus: FeeStatus.PRECHARGED, currency: quote.currency, estimatedChargeableKg: input.estimatedChargeableKg, prechargedAmount: precharge, recipientName: input.recipientName, recipientCompany: input.recipientCompany, recipientPhone: input.recipientPhone, recipientCountryCode: input.recipientCountryCode, recipientPostcode: input.recipientPostcode, recipientCity: input.recipientCity, recipientAddressRaw: recipientAddress.raw, recipientAddressLine1: recipientAddress.line1, recipientAddressLine2: recipientAddress.line2, recipientAddressLine3: recipientAddress.line3, recipientResidential: input.recipientResidential ?? false, clientReference: input.clientReference?.trim() || null, taxWith: input.taxWith ?? 0, taxNumber: input.taxNumber?.trim() || null, deliveryWith: input.deliveryWith ?? '', exportWith: input.exportWith ?? 0, importWith: input.importWith ?? 0, shipmentAttrs: (input.shipmentAttrs ?? []) as Prisma.InputJsonValue, fromAddress: input.fromAddress as Prisma.InputJsonValue | undefined, toAddress: input.toAddress as Prisma.InputJsonValue | undefined, boxes: { create: input.boxes.map((box) => ({ ...box, items: { create: box.items.map((item) => this.normalizeItem(item)) } })) }, ...(service.supplier.environment === ChannelEnvironment.PRODUCTION && !options.allowSandbox ? { dispatchJob: { create: {} } } : {}), feeLines: { create: [
        { feeType: 'SUPPLIER_WEIGHT_FREIGHT', amount: quote.weightFreight, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_MINIMUM_BOX_ADJUSTMENT', amount: quote.minimumPerBoxAdjustment, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_MINIMUM_SHIPMENT_ADJUSTMENT', amount: quote.minimumPerShipmentAdjustment, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_REGISTRATION_FEE', amount: quote.registrationFee, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_OPERATION_FEE', amount: quote.operationFee, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SERVICE_PROFIT', amount: quote.serviceProfit, currency: quote.currency, snapshot: { profitVersion: quote.profitVersion, profitVersionId: quote.profitVersionId, scope: quote.profitScope, scopeTargetId: quote.profitScopeTargetId, rule: quote.profitRule } },
        { feeType: 'FUEL', amount: quote.fuelFee, currency: quote.currency, snapshot: {} }, { feeType: 'REMOTE', amount: quote.remoteFee, currency: quote.currency, snapshot: {} }, { feeType: 'OVERWEIGHT', amount: quote.overweightFee, currency: quote.currency, snapshot: {} },
      ] } } });
      const after = wallet.balance.minus(precharge);
      await tx.customerWallet.update({ where: { id: wallet.id }, data: { balance: after, version: { increment: 1 } } });
      await tx.walletLedger.create({ data: { ledgerNo: this.number('LED'), walletId: wallet.id, type: WalletLedgerType.SHIPPING_PRECHARGE, amount: precharge.negated(), balanceBefore: wallet.balance, balanceAfter: after, relatedOrderId: order.id, reason: `订单 ${order.orderNo} 预扣` } });
      await this.balanceAlerts.evaluateInTransaction(tx, { customerId: customer.id, customerNo: customer.customerNo, username: customer.username, walletId: wallet.id, currency: wallet.currency, balance: after });
      return order;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  listForCustomer(customerId: string) { return this.prisma.order.findMany({ where: { customerId }, include: { service: { select: { code: true, name: true } }, feeLines: true, labels: { select: { id: true, trackingNumber: true, contentType: true, createdAt: true } } }, orderBy: { createdAt: 'desc' } }); }
  createForAdmin(customerId: string, input: CreateOrderInput) { return this.createForCustomer(customerId, input, { allowSandbox: true }); }
  async previewImportForAdmin(rows: ImportOrderRow[]) {
    return Promise.all(rows.map(async (row) => {
      try {
        const customer = await this.prisma.customer.findUnique({ where: { id: row.customerId }, include: { wallets: true } });
        if (!customer) throw new NotFoundException('客户不存在');
        if (customer.status !== CustomerStatus.NORMAL) throw new ForbiddenException('客户状态不可下单');
        const service = await this.prisma.service.findUnique({ where: { id: row.order.serviceId }, include: { supplier: true } });
        if (!service?.enabled) throw new NotFoundException('服务不存在或已停用');
        await this.assertShipmentInput(row.order as CreateOrderInput, service.supplier.driverCode);
        if (!service.allowsMultiPiece && row.order.boxes.length !== 1) throw new BadRequestException('该服务仅支持一票一件');
        if (row.order.boxes.length < service.minPieces) throw new BadRequestException('订单箱数低于服务最小件数');
        const weights = service.measurementMethod === MeasurementMethod.PER_SHIPMENT ? [row.order.estimatedChargeableKg] : row.order.boxes.map((box) => box.weightKg);
        const quote = await this.pricing.quote(row.customerId, row.order.serviceId, row.order.recipientCountryCode, weights, row.order.recipientPostcode, row.order.boxes);
        const wallet = customer.wallets.find((item) => item.currency === quote.currency);
        if (!wallet || wallet.balance.lessThan(quote.total) || wallet.balance.lessThan(0)) throw new ForbiddenException(`${quote.currency} 余额不足`);
        return { rowNo: row.rowNo, status: 'READY' as const, currency: quote.currency, estimatedReceivable: quote.total };
      } catch (error) { return { rowNo: row.rowNo, status: 'ERROR' as const, error: error instanceof Error ? error.message : '预校验失败' }; }
    }));
  }
  async importForAdmin(sourceFileName: string, rows: ImportOrderRow[]) {
    const results = [];
    for (const row of rows) {
      try {
        const idempotencyKey = `excel-${createHash('sha256').update(JSON.stringify({ sourceFileName, rowNo: row.rowNo, customerId: row.customerId, order: row.order })).digest('hex').slice(0, 48)}`;
        const order = await this.createForAdmin(row.customerId, { ...row.order, idempotencyKey });
        results.push({ rowNo: row.rowNo, status: 'CREATED' as const, orderId: order.id, orderNo: order.orderNo });
      } catch (error) { results.push({ rowNo: row.rowNo, status: 'ERROR' as const, error: error instanceof Error ? error.message : '导入失败' }); }
    }
    return results;
  }
  listForAdmin() { return this.prisma.order.findMany({ include: { customer: { select: { id: true, customerNo: true, username: true } }, service: { select: { id: true, code: true, name: true, carrierServiceType: true, supplier: { select: { driverCode: true, environment: true, carrier: { select: { name: true } } } } } }, labels: { select: { id: true, trackingNumber: true, contentType: true, createdAt: true } } }, orderBy: { createdAt: 'desc' } }); }
  async getForAdmin(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, customerNo: true, username: true, wallets: { select: { currency: true, balance: true } } } },
        service: { include: { supplier: { include: { carrier: { select: { code: true, name: true } } } } } },
        boxes: { include: { items: true } }, feeLines: true,
        labels: { select: { id: true, trackingNumber: true, contentType: true, createdAt: true } },
        connectorCalls: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return order;
  }
  async getLabelForAdmin(orderId: string, labelId: string) { const label = await this.prisma.shipmentLabel.findFirst({ where: { id: labelId, orderId }, select: { id: true, trackingNumber: true, contentType: true, content: true } }); if (!label) throw new NotFoundException('面单不存在'); return label; }
  async getForCustomer(customerId: string, orderId: string) { const order = await this.prisma.order.findFirst({ where: { id: orderId, customerId }, include: { service: true, boxes: { include: { items: true } }, feeLines: true, labels: { select: { id: true, trackingNumber: true, contentType: true, createdAt: true } } } }); if (!order) throw new NotFoundException('订单不存在'); return order; }
  async getLabelForCustomer(customerId: string, orderId: string, labelId: string) {
    const label = await this.prisma.shipmentLabel.findFirst({ where: { id: labelId, orderId, order: { customerId } }, select: { id: true, trackingNumber: true, contentType: true, content: true } });
    if (!label) throw new NotFoundException('面单不存在或无权访问'); return label;
  }
  private async assertShipmentInput(input: CreateOrderInput, driverCode?: string) {
    const required = await this.settings.requiredDeclarationFields(driverCode); const needs = (field: DeclarationFieldCode) => required.has(field);
    const boxNos = new Set<string>();
    const declarationCurrencies = new Set<string>();
    for (const box of input.boxes) {
      if (!box.boxNo.trim()) throw new BadRequestException('箱号不能为空');
      if (boxNos.has(box.boxNo)) throw new BadRequestException(`箱号重复：${box.boxNo}`);
      boxNos.add(box.boxNo);
      if ([box.weightKg, box.lengthCm, box.widthCm, box.heightCm].some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0)) throw new BadRequestException(`箱号 ${box.boxNo} 的重量和尺寸必须大于 0`);
      if (!box.items.length) throw new BadRequestException(`箱号 ${box.boxNo} 至少需要一条申报明细`);
      for (const item of box.items) {
        const missing = (field: DeclarationFieldCode, label: string, value: unknown) => { if (needs(field) && (value === undefined || value === null || String(value).trim() === '')) throw new BadRequestException(`箱号 ${box.boxNo} 的申报明细缺少${label}`); };
        missing('chineseName', '中文品名', item.chineseName); missing('englishName', '英文品名', item.englishName); missing('material', '材质', item.material); missing('originCountryCode', '原产国', item.originCountryCode); missing('harmonizedCode', 'HS 编码', item.harmonizedCode); missing('declaredValueCurrency', '申报币种', item.declaredValueCurrency);
        if (needs('quantity') && (!Number.isInteger(item.quantity) || item.quantity! < 1)) throw new BadRequestException(`箱号 ${box.boxNo} 的申报数量必须为正整数`);
        if (item.quantity !== undefined && (!Number.isInteger(item.quantity) || item.quantity < 1)) throw new BadRequestException(`箱号 ${box.boxNo} 的申报数量必须为正整数`);
        if (needs('unitDeclaredValue') && (!Number.isFinite(Number(item.unitDeclaredValue)) || Number(item.unitDeclaredValue) <= 0)) throw new BadRequestException(`箱号 ${box.boxNo} 的申报单价必须大于 0`);
        if (item.unitDeclaredValue !== undefined && item.unitDeclaredValue !== '' && (!Number.isFinite(Number(item.unitDeclaredValue)) || Number(item.unitDeclaredValue) <= 0)) throw new BadRequestException(`箱号 ${box.boxNo} 的申报单价必须大于 0`);
        if (item.declaredValueCurrency) declarationCurrencies.add(item.declaredValueCurrency);
      }
    }
    if (declarationCurrencies.size > 1) throw new BadRequestException('同一票订单的申报明细必须使用同一币种');
  }
  private normalizeItem(item: ItemInput) { return { chineseName: item.chineseName?.trim() || null, englishName: item.englishName?.trim() || null, material: item.material?.trim() || null, originCountryCode: item.originCountryCode?.trim().toUpperCase() || null, harmonizedCode: item.harmonizedCode?.trim() || null, quantity: item.quantity ?? null, unitDeclaredValue: item.unitDeclaredValue?.trim() || null, declaredValueCurrency: item.declaredValueCurrency ?? null, sku: item.sku?.trim() || null, itemWeightKg: item.itemWeightKg?.trim() || null, itemLengthCm: item.itemLengthCm?.trim() || null, itemWidthCm: item.itemWidthCm?.trim() || null, itemHeightCm: item.itemHeightCm?.trim() || null }; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`; }
}
