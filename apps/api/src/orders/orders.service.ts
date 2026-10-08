import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CustomerStatus, FeeStatus, MeasurementMethod, Prisma, ShipmentDispatchJobStatus, ShipmentStatus, WalletLedgerType } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { BalanceAlertsService } from '../balance-alerts/balance-alerts.service';
import { SettingsService } from '../settings/settings.service';
import { normalizeRecipientAddress } from './recipient-address';
import { ShipmentDispatchQueueService } from '../open-api/shipment-dispatch-queue.service';
import { supportsAutomaticShipment, getConnectorDriver } from '../connectors/connector-drivers.registry';
import { assertUpsInput } from '../connectors/ups-official.mapper';
import { UpsLabelService } from './ups-label.service';
import { ProductsService } from '../products/products.service';
import { TrackingService } from '../tracking/tracking.service';

export type ItemInput = { chineseName?: string; englishName?: string; material?: string; originCountryCode?: string; harmonizedCode?: string; quantity?: number; unitDeclaredValue?: string; declaredValueCurrency?: 'EUR' | 'GBP'; sku?: string; itemWeightKg?: string; itemLengthCm?: string; itemWidthCm?: string; itemHeightCm?: string };
export type BoxInput = { boxNo?: string; reference?: string; weightKg: string; lengthCm: string; widthCm: string; heightCm: string; items: ItemInput[] };
export type CreateOrderInput = { idempotencyKey: string; supplierId: string; recipientName: string; recipientCompany?: string; recipientPhone?: string; recipientCountryCode: string; recipientPostcode: string; recipientCity: string; recipientState?: string; recipientAddress?: string; recipientAddressLine1?: string; recipientAddressLine2?: string; recipientAddressLine3?: string; recipientResidential?: boolean; estimatedChargeableKg: string; boxes: BoxInput[]; clientReference?: string; taxWith?: number; taxNumber?: string; deliveryWith?: string; exportWith?: number; importWith?: number; shipmentAttrs?: string[]; fromAddress?: Record<string, unknown>; toAddress?: Record<string, unknown> };
export type ImportOrderRow = { rowNo: number; customerId: string; order: Omit<CreateOrderInput, 'idempotencyKey'> };

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService, private readonly pricing: PricingService, private readonly balanceAlerts: BalanceAlertsService, private readonly settings: SettingsService, private readonly products: ProductsService, private readonly dispatchQueue?: ShipmentDispatchQueueService, private readonly upsLabels?: UpsLabelService, private readonly tracking?: TrackingService) {}

  async createForCustomer(customerId: string, input: CreateOrderInput, options: { allowSandbox?: boolean; requestedServiceId?: string; openRequest?: { idempotencyKeyHash: string; requestHash: string } } = {}) {
    if (!input.boxes.length) throw new BadRequestException('至少需要一个箱号');
    const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.customerId !== customerId) throw new ConflictException('幂等键已被其他客户使用');
      if (options.openRequest) await this.assertOpenReplay(customerId, existing.id, options.openRequest);
      return existing;
    }
    const orderNo = this.number('ORD');
    const normalizedInput = { ...input, recipientCountryCode: await this.pricing.resolveDestinationCountry(input.recipientCountryCode), recipientState: input.recipientState?.trim() || undefined, boxes: this.normalizeBoxNumbers(input.boxes, orderNo) };
    const resolved = options.requestedServiceId
      ? await this.products.resolvePublicServiceRoute(options.requestedServiceId, normalizedInput.recipientCountryCode)
      : await this.products.resolveOrderRoute(input.supplierId, normalizedInput.recipientCountryCode, Boolean(options.allowSandbox));
    const recipientAddress = normalizeRecipientAddress(input.recipientAddress === undefined ? [input.recipientAddressLine1, input.recipientAddressLine2, input.recipientAddressLine3] : [input.recipientAddress], resolved.supplier.driverCode);
    if (resolved.supplier.driverCode === 'UPS_OFFICIAL') assertUpsInput(normalizedInput);
    const service = resolved.service;
    this.assertRouteOptions(normalizedInput, resolved.route.fieldSchema);
    await this.assertShipmentInput(normalizedInput, undefined, resolved.route.fieldSchema);
    if (!service.allowsMultiPiece && normalizedInput.boxes.length !== 1) throw new BadRequestException('该服务仅支持一票一件');
    if (normalizedInput.boxes.length < service.minPieces) throw new BadRequestException('订单箱数低于服务最小件数');
    const quoteWeights = service.measurementMethod === MeasurementMethod.PER_SHIPMENT ? [normalizedInput.estimatedChargeableKg] : normalizedInput.boxes.map((box) => box.weightKg);
    const quote = await this.pricing.quote(customerId, service.id, normalizedInput.recipientCountryCode, quoteWeights, normalizedInput.recipientPostcode, normalizedInput.boxes);
    const precharge = new Prisma.Decimal(quote.total);
    const order = await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, include: { wallets: true } });
      if (!customer) throw new NotFoundException('客户不存在');
      if (customer.status === CustomerStatus.FROZEN || customer.status === CustomerStatus.REJECTED || customer.status === CustomerStatus.PENDING_REVIEW || customer.status === CustomerStatus.PENDING_RECHARGE_VERIFICATION) throw new ForbiddenException('当前客户状态不可下单');
      const wallet = customer.wallets.find((item) => item.currency === quote.currency);
      if (!wallet || wallet.balance.lessThan(precharge) || wallet.balance.lessThan(0)) throw new ForbiddenException(`${quote.currency} 余额不足，无法创建订单`);
      const dispatchJob = supportsAutomaticShipment(resolved.supplier.driverCode)
        ? { create: { status: ShipmentDispatchJobStatus.PENDING, stage: 'QUEUED', reasonCode: 'QUEUED', publicMessage: '订单已受理，正在等待面单生成' } }
        : { create: { status: ShipmentDispatchJobStatus.BLOCKED, stage: 'UNSUPPORTED', reasonCode: 'DRIVER_NOT_SUPPORTED', publicMessage: '当前供应商连接暂不支持自动生成面单' } };
      const routeSnapshot = { driverCode: resolved.supplier.driverCode, environment: resolved.supplier.environment, accountFingerprint: resolved.accountFingerprint ?? null, shipperCountryCode: resolved.shipperCountryCode ?? null, packageOrder: normalizedInput.boxes.map(box => box.boxNo), routeId: resolved.route.id, routeCode: resolved.route.code, routeName: resolved.route.name, routeType: resolved.route.routeType, supplierId: resolved.supplier.id, supplierCode: resolved.supplier.code, supplierName: resolved.supplier.name, carrierServiceType: resolved.route.carrierServiceType, fieldSchema: resolved.route.fieldSchema, internalServiceId: service.id, internalServiceCode: service.code };
      const order = await tx.order.create({ data: { orderNo, idempotencyKey: normalizedInput.idempotencyKey, customerId, serviceId: service.id, supplierRouteId: resolved.route.id, supplierRouteSnapshot: routeSnapshot as Prisma.InputJsonValue, shipmentStatus: ShipmentStatus.SUBMITTED, feeStatus: FeeStatus.PRECHARGED, currency: quote.currency, estimatedChargeableKg: normalizedInput.estimatedChargeableKg, prechargedAmount: precharge, recipientName: normalizedInput.recipientName, recipientCompany: normalizedInput.recipientCompany, recipientPhone: normalizedInput.recipientPhone, recipientCountryCode: normalizedInput.recipientCountryCode, recipientPostcode: normalizedInput.recipientPostcode, recipientCity: normalizedInput.recipientCity, recipientState: normalizedInput.recipientState ?? null, recipientAddressRaw: recipientAddress.raw, recipientAddressLine1: recipientAddress.line1, recipientAddressLine2: recipientAddress.line2, recipientAddressLine3: recipientAddress.line3, recipientResidential: normalizedInput.recipientResidential ?? false, clientReference: normalizedInput.clientReference?.trim() || null, taxWith: normalizedInput.taxWith ?? 0, taxNumber: normalizedInput.taxNumber?.trim() || null, deliveryWith: normalizedInput.deliveryWith ?? '', exportWith: normalizedInput.exportWith ?? 0, importWith: normalizedInput.importWith ?? 0, shipmentAttrs: (normalizedInput.shipmentAttrs ?? []) as Prisma.InputJsonValue, fromAddress: normalizedInput.fromAddress as Prisma.InputJsonValue | undefined, toAddress: normalizedInput.toAddress as Prisma.InputJsonValue | undefined, boxes: { create: normalizedInput.boxes.map((box) => ({ ...box, items: { create: box.items.map((item) => this.normalizeItem(item)) } })) }, dispatchJob, feeLines: { create: [
        { feeType: 'SUPPLIER_WEIGHT_FREIGHT', amount: quote.weightFreight, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_MINIMUM_BOX_ADJUSTMENT', amount: quote.minimumPerBoxAdjustment, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_MINIMUM_SHIPMENT_ADJUSTMENT', amount: quote.minimumPerShipmentAdjustment, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_REGISTRATION_FEE', amount: quote.registrationFee, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SUPPLIER_OPERATION_FEE', amount: quote.operationFee, currency: quote.currency, snapshot: { costVersion: quote.costVersion, priceColumn: quote.priceColumn } },
        { feeType: 'SERVICE_PROFIT', amount: quote.serviceProfit, currency: quote.currency, snapshot: { profitVersion: quote.profitVersion, profitVersionId: quote.profitVersionId, scope: quote.profitScope, scopeTargetId: quote.profitScopeTargetId, rule: quote.profitRule } },
        { feeType: 'FUEL', amount: quote.fuelFee, currency: quote.currency, snapshot: {} }, { feeType: 'REMOTE', amount: quote.remoteFee, currency: quote.currency, snapshot: {} }, { feeType: 'OVERWEIGHT', amount: quote.overweightFee, currency: quote.currency, snapshot: {} },
      ] } } });
      if (options.openRequest) await tx.openApiIdempotencyRecord.create({ data: { customerId, ...options.openRequest, orderId: order.id } });
      const after = wallet.balance.minus(precharge);
      await tx.customerWallet.update({ where: { id: wallet.id }, data: { balance: after, version: { increment: 1 } } });
      await tx.walletLedger.create({ data: { ledgerNo: this.number('LED'), walletId: wallet.id, type: WalletLedgerType.SHIPPING_PRECHARGE, amount: precharge.negated(), balanceBefore: wallet.balance, balanceAfter: after, relatedOrderId: order.id, reason: `订单 ${order.orderNo} 预扣` } });
      await this.balanceAlerts.evaluateInTransaction(tx, { customerId: customer.id, customerNo: customer.customerNo, username: customer.username, walletId: wallet.id, currency: wallet.currency, balance: after });
      return order;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(async error => {
      // Re-read after a concurrent unique/serializable conflict; never repeat a debit.
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        const recovered = await this.prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (recovered?.customerId === customerId) {
          if (options.openRequest) await this.assertOpenReplay(customerId, recovered.id, options.openRequest);
          return recovered;
        }
      }
      throw error;
    });
    if (supportsAutomaticShipment(resolved.supplier.driverCode)) await this.dispatchQueue?.enqueue(order.id).catch(() => undefined);
    return order;
  }

  private async assertOpenReplay(customerId: string, orderId: string, request: { idempotencyKeyHash: string; requestHash: string }) {
    const record = await this.prisma.openApiIdempotencyRecord.findUnique({ where: { customerId_idempotencyKeyHash: { customerId, idempotencyKeyHash: request.idempotencyKeyHash } } });
    if (!record || record.orderId !== orderId || record.requestHash !== request.requestHash) throw new ConflictException('同一 Idempotency-Key 对应的请求内容不一致或历史幂等记录不完整，请管理员核查');
  }

  async listForCustomer(customerId: string) {
    const orders = await this.prisma.order.findMany({ where: { customerId }, include: { service: { select: { code: true, name: true } }, feeLines: true, labels: { select: { id: true, trackingNumber: true, contentType: true, box: { select: { boxNo: true } }, createdAt: true } }, dispatchJob: true }, orderBy: { createdAt: 'desc' } });
    const summaries = await this.tracking?.listSummaries(orders.map(order => order.id), false);
    return orders.map((order) => ({ ...order, dispatch: this.dispatchSummary(order, false), tracking: summaries?.get(order.id) ?? { status: 'PENDING', syncStatus: 'PENDING', lastSyncedAt: null }, dispatchJob: undefined }));
  }
  createForAdmin(customerId: string, input: CreateOrderInput) { return this.createForCustomer(customerId, input, { allowSandbox: true }); }
  async quoteForCustomer(customerId: string, input: CreateOrderInput, allowSandbox = false) {
    const normalized = { ...input, recipientCountryCode: await this.pricing.resolveDestinationCountry(input.recipientCountryCode), boxes: this.normalizeBoxNumbers(input.boxes, 'QUOTE') };
    const resolved = await this.products.resolveOrderRoute(input.supplierId, normalized.recipientCountryCode, allowSandbox);
    normalizeRecipientAddress(input.recipientAddress === undefined ? [input.recipientAddressLine1, input.recipientAddressLine2, input.recipientAddressLine3] : [input.recipientAddress], resolved.supplier.driverCode);
    this.assertRouteOptions(normalized, resolved.route.fieldSchema);
    await this.assertShipmentInput(normalized, undefined, resolved.route.fieldSchema);
    if (resolved.supplier.driverCode === 'UPS_OFFICIAL') assertUpsInput(normalized);
    if (!resolved.service.allowsMultiPiece && input.boxes.length !== 1) throw new BadRequestException('该服务仅支持一票一件');
    if (input.boxes.length < resolved.service.minPieces) throw new BadRequestException('订单箱数低于服务最小件数');
    const weights = resolved.service.measurementMethod === MeasurementMethod.PER_SHIPMENT ? [input.estimatedChargeableKg] : input.boxes.map(box => box.weightKg);
    return this.pricing.quote(customerId, resolved.service.id, normalized.recipientCountryCode, weights, input.recipientPostcode, input.boxes);
  }
  orderableSuppliers(allowSandbox: boolean) { return this.products.orderableSuppliers(allowSandbox); }
  resolveOrderRoute(supplierId: string, countryCode: string, allowSandbox: boolean) { return this.products.resolveOrderRoute(supplierId, countryCode, allowSandbox); }
  async previewImportForAdmin(rows: ImportOrderRow[]) {
    return Promise.all(rows.map(async (row) => {
      try {
        const customer = await this.prisma.customer.findUnique({ where: { id: row.customerId }, include: { wallets: true } });
        if (!customer) throw new NotFoundException('客户不存在');
        if (customer.status !== CustomerStatus.NORMAL) throw new ForbiddenException('客户状态不可下单');
        const previewOrder = { ...row.order, recipientCountryCode: await this.pricing.resolveDestinationCountry(row.order.recipientCountryCode), boxes: this.normalizeBoxNumbers(row.order.boxes, `PREVIEW-${row.rowNo}`) } as CreateOrderInput;
        const resolved = await this.products.resolveOrderRoute(previewOrder.supplierId, previewOrder.recipientCountryCode, true);
        normalizeRecipientAddress(previewOrder.recipientAddress === undefined ? [previewOrder.recipientAddressLine1, previewOrder.recipientAddressLine2, previewOrder.recipientAddressLine3] : [previewOrder.recipientAddress], resolved.supplier.driverCode);
        if (resolved.supplier.driverCode === 'UPS_OFFICIAL') assertUpsInput(previewOrder);
        const service = resolved.service;
        this.assertRouteOptions(previewOrder, resolved.route.fieldSchema);
        await this.assertShipmentInput(previewOrder, undefined, resolved.route.fieldSchema);
        if (!service.allowsMultiPiece && previewOrder.boxes.length !== 1) throw new BadRequestException('该服务仅支持一票一件');
        if (previewOrder.boxes.length < service.minPieces) throw new BadRequestException('订单箱数低于服务最小件数');
        const weights = service.measurementMethod === MeasurementMethod.PER_SHIPMENT ? [previewOrder.estimatedChargeableKg] : previewOrder.boxes.map((box) => box.weightKg);
        const quote = await this.pricing.quote(row.customerId, service.id, previewOrder.recipientCountryCode, weights, previewOrder.recipientPostcode, previewOrder.boxes);
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
        results.push({
          rowNo: row.rowNo,
          status: 'CREATED' as const,
          orderId: order.id,
          orderNo: order.orderNo,
          labelStatus: 'PENDING' as const,
          message: '下单成功，已完成预扣，正在自动校验并生成面单。',
        });
      } catch (error) { results.push({ rowNo: row.rowNo, status: 'ERROR' as const, error: error instanceof Error ? error.message : '导入失败' }); }
    }
    return results;
  }
  async listForAdmin() {
    const orders = await this.prisma.order.findMany({ include: { customer: { select: { id: true, customerNo: true, username: true } }, service: { select: { id: true, code: true, name: true, carrierServiceType: true, supplier: { select: { driverCode: true, environment: true, carrier: { select: { name: true } } } } } }, labels: { select: { id: true, trackingNumber: true, contentType: true, box: { select: { boxNo: true } }, createdAt: true } }, dispatchJob: true }, orderBy: { createdAt: 'desc' } });
    const summaries = await this.tracking?.listSummaries(orders.map(order => order.id), true);
    return orders.map((order) => ({ ...order, connectorCapabilities: getConnectorDriver(order.service.supplier.driverCode)?.capabilities, dispatch: this.dispatchSummary(order, true), tracking: summaries?.get(order.id) ?? { status: 'PENDING', syncStatus: 'PENDING', lastSyncedAt: null } }));
  }
  async getForAdmin(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, customerNo: true, username: true, wallets: { select: { currency: true, balance: true } } } },
        service: { include: { supplier: { include: { carrier: { select: { code: true, name: true } } } } } },
        boxes: { include: { items: true } }, feeLines: true,
        labels: { select: { id: true, trackingNumber: true, contentType: true, box: { select: { boxNo: true } }, createdAt: true } },
        connectorCalls: { orderBy: { createdAt: 'desc' }, take: 20 }, dispatchJob: true,
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return { ...order, connectorCapabilities: getConnectorDriver(order.service.supplier.driverCode)?.capabilities, dispatch: this.dispatchSummary(order, true) };
  }
  async getLabelForAdmin(orderId: string, labelId: string) { const label = await this.prisma.shipmentLabel.findFirst({ where: { id: labelId, orderId }, select: { id: true, trackingNumber: true, contentType: true, content: true, sourceContent: true } }); if (!label) throw new NotFoundException('面单不存在'); return this.upsLabels ? this.upsLabels.ensure(label) : label; }
  async getForCustomer(customerId: string, orderId: string) { const order = await this.prisma.order.findFirst({ where: { id: orderId, customerId }, include: { service: true, boxes: { include: { items: true } }, feeLines: true, labels: { select: { id: true, trackingNumber: true, contentType: true, box: { select: { boxNo: true } }, createdAt: true } }, dispatchJob: true } }); if (!order) throw new NotFoundException('订单不存在'); return { ...order, dispatch: this.dispatchSummary(order, false), dispatchJob: undefined }; }
  async dispatchStatusesForAdmin(orderIds: string[]) {
    const orders = await this.loadDispatchOrders(orderIds);
    return orders.map((order) => ({ orderId: order.id, orderNo: order.orderNo, dispatch: this.dispatchSummary(order, true) }));
  }
  async dispatchStatusesForCustomer(customerId: string, orderIds: string[]) {
    const ids = this.normalizedOrderIds(orderIds);
    const orders = await this.prisma.order.findMany({ where: { id: { in: ids }, customerId }, include: { labels: { select: { id: true } }, dispatchJob: true } });
    return orders.map((order) => ({ orderId: order.id, orderNo: order.orderNo, dispatch: this.dispatchSummary(order, false) }));
  }
  async getLabelForCustomer(customerId: string, orderId: string, labelId: string) {
    const label = await this.prisma.shipmentLabel.findFirst({ where: { id: labelId, orderId, order: { customerId } }, select: { id: true, trackingNumber: true, contentType: true, content: true, sourceContent: true } });
    if (!label) throw new NotFoundException('面单不存在或无权访问'); return this.upsLabels ? this.upsLabels.ensure(label) : label;
  }

  private async loadDispatchOrders(orderIds: string[]) {
    const ids = this.normalizedOrderIds(orderIds);
    return this.prisma.order.findMany({ where: { id: { in: ids } }, include: { labels: { select: { id: true } }, dispatchJob: true } });
  }

  private normalizedOrderIds(orderIds: string[]) {
    const ids = [...new Set(orderIds.map((value) => value.trim()).filter(Boolean))];
    if (ids.length > 100) throw new BadRequestException('单次最多查询 100 个订单状态');
    return ids;
  }

  dispatchSummary(order: { shipmentStatus: ShipmentStatus; labels: Array<unknown>; dispatchJob: any }, admin: boolean) {
    const job = order.dispatchJob;
    const terminalOrderStatus = order.shipmentStatus;
    const now = Date.now();
    const base = { retryAllowed: false };
    if (terminalOrderStatus === ShipmentStatus.UNKNOWN) return { ...base, status: 'UNKNOWN', stage: 'UNKNOWN', reasonCode: 'SUPPLIER_RESULT_UNKNOWN', message: '供应商创建或取消结果未知，请人工核查，不要重复打单或自动重试', lastActivityAt: job?.updatedAt ?? null };
    if (terminalOrderStatus === ShipmentStatus.GENERATED && job?.reasonCode === 'LABEL_PROCESSING_FAILED') return { ...base, status: 'FAILED', stage: 'PDF_PROCESSING', reasonCode: 'LABEL_PROCESSING_FAILED', message: '运单已生成，PDF 处理失败；再次预览/下载仅重做本地转换，不会重复打单', lastActivityAt: job.updatedAt };
    if (terminalOrderStatus === ShipmentStatus.GENERATED || (job?.status === ShipmentDispatchJobStatus.COMPLETED && order.labels.length > 0)) return { ...base, status: 'READY', stage: 'READY', message: '面单已生成，可预览或下载 PDF', reasonCode: 'LABEL_READY', lastActivityAt: job?.updatedAt ?? null };
    if (terminalOrderStatus === ShipmentStatus.CANCELLED) return { ...base, status: 'CANCELLED', stage: 'CANCELLED', message: '订单已取消', reasonCode: 'ORDER_CANCELLED', lastActivityAt: job?.updatedAt ?? null };
    if (!job) return { ...base, status: 'BLOCKED', stage: 'UNSUPPORTED', message: '该历史订单未纳入自动面单任务，请联系管理员核查', reasonCode: 'DISPATCH_JOB_MISSING', lastActivityAt: null };
    const referenceAt = job.status === ShipmentDispatchJobStatus.PROCESSING ? job.startedAt ?? job.claimedAt ?? job.updatedAt : job.queuedAt ?? job.updatedAt;
    if ([ShipmentDispatchJobStatus.PENDING, ShipmentDispatchJobStatus.PROCESSING].includes(job.status) && referenceAt && now - new Date(referenceAt).getTime() >= 10 * 60_000) {
      const waitingWorker = job.status === ShipmentDispatchJobStatus.PENDING;
      return { ...base, status: 'STALLED', stage: job.stage ?? (waitingWorker ? 'QUEUED' : 'PROCESSING'), message: waitingWorker ? '面单任务超过 10 分钟未被 Worker 领取，请检查 Redis 或 Worker 状态' : '面单生成处理超过 10 分钟，请核查供应商响应', reasonCode: waitingWorker ? 'WORKER_NOT_CLAIMED' : 'PROCESSING_TIMEOUT', lastActivityAt: job.updatedAt, ...(admin && job.errorMessage ? { technicalDetail: job.errorMessage } : {}) };
    }
    const status = job.status === ShipmentDispatchJobStatus.PENDING ? 'PENDING' : job.status === ShipmentDispatchJobStatus.PROCESSING ? (job.stage === 'CREATING' ? 'CREATING' : 'VALIDATING') : job.status === ShipmentDispatchJobStatus.COMPLETED ? 'READY' : job.status;
    const fallback = status === 'FAILED' ? '面单生成失败，请查看失败原因' : status === 'UNKNOWN' ? '面单生成结果未知，请勿重复下单并联系管理员核查' : status === 'BLOCKED' ? '当前供应商连接暂不支持自动生成面单' : status === 'CREATING' ? '正在向供应商生成面单' : status === 'VALIDATING' ? '正在校验订单信息' : '订单已受理，正在等待面单生成';
    return { ...base, status, stage: job.stage ?? null, message: job.publicMessage ?? fallback, reasonCode: job.reasonCode ?? null, lastActivityAt: job.updatedAt, ...(admin && job.errorMessage ? { technicalDetail: job.errorMessage } : {}) };
  }
  private async assertShipmentInput(input: CreateOrderInput, driverCode?: string, routeSchema: { declarationRequired?: string[]; carrierRules?: { packageMaxWeightKg?: number | null } } = {}) {
    const required = new Set<string>(await this.settings.requiredDeclarationFields(driverCode));
    for (const field of routeSchema.declarationRequired ?? []) required.add(field);
    const needs = (field: string) => required.has(field);
    const boxNos = new Set<string>();
    const declarationCurrencies = new Set<string>();
    for (const box of input.boxes) {
      const boxNo = box.boxNo?.trim();
      if (!boxNo) throw new BadRequestException('系统未能生成箱号');
      if (boxNos.has(boxNo)) throw new BadRequestException(`箱号重复：${boxNo}`);
      boxNos.add(boxNo);
      if ([box.weightKg, box.lengthCm, box.widthCm, box.heightCm].some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0)) throw new BadRequestException(`箱号 ${boxNo} 的重量和尺寸必须大于 0`);
      const packageMaxWeightKg = routeSchema.carrierRules?.packageMaxWeightKg;
      if (packageMaxWeightKg && Number(box.weightKg) > packageMaxWeightKg) throw new BadRequestException(`箱号 ${boxNo} 超出该线路单箱 ${packageMaxWeightKg} kg 限制`);
      if (!box.items.length) throw new BadRequestException(`箱号 ${boxNo} 至少需要一条申报明细`);
      let declaredNetWeight = 0;
      for (const item of box.items) {
        const missing = (field: string, label: string, value: unknown) => { if (needs(field) && (value === undefined || value === null || String(value).trim() === '')) throw new BadRequestException(`箱号 ${boxNo} 的申报明细缺少${label}`); };
        missing('chineseName', '中文品名', item.chineseName); missing('englishName', '英文品名', item.englishName); missing('material', '材质', item.material); missing('originCountryCode', '原产国', item.originCountryCode); missing('harmonizedCode', 'HS 编码', item.harmonizedCode); missing('declaredValueCurrency', '申报币种', item.declaredValueCurrency);
        if (needs('quantity') && (!Number.isInteger(item.quantity) || item.quantity! < 1)) throw new BadRequestException(`箱号 ${boxNo} 的申报数量必须为正整数`);
        if (item.quantity !== undefined && (!Number.isInteger(item.quantity) || item.quantity < 1)) throw new BadRequestException(`箱号 ${boxNo} 的申报数量必须为正整数`);
        if (needs('itemWeightKg') && (!Number.isFinite(Number(item.itemWeightKg)) || Number(item.itemWeightKg) <= 0)) throw new BadRequestException(`箱号 ${boxNo} 的申报货品净重必须大于 0`);
        if (item.itemWeightKg !== undefined && item.itemWeightKg !== '' && (!Number.isFinite(Number(item.itemWeightKg)) || Number(item.itemWeightKg) <= 0)) throw new BadRequestException(`箱号 ${boxNo} 的申报货品净重必须大于 0`);
        declaredNetWeight += Number(item.itemWeightKg ?? 0);
        if (needs('unitDeclaredValue') && (!Number.isFinite(Number(item.unitDeclaredValue)) || Number(item.unitDeclaredValue) <= 0)) throw new BadRequestException(`箱号 ${boxNo} 的申报单价必须大于 0`);
        if (item.unitDeclaredValue !== undefined && item.unitDeclaredValue !== '' && (!Number.isFinite(Number(item.unitDeclaredValue)) || Number(item.unitDeclaredValue) <= 0)) throw new BadRequestException(`箱号 ${boxNo} 的申报单价必须大于 0`);
        if (item.declaredValueCurrency) declarationCurrencies.add(item.declaredValueCurrency);
      }
      if (needs('itemWeightKg') && declaredNetWeight > Number(box.weightKg) + 0.000001) throw new BadRequestException(`箱号 ${boxNo} 的申报货品净重合计不得超过箱子实重`);
    }
    if (declarationCurrencies.size > 1) throw new BadRequestException('同一票订单的申报明细必须使用同一币种');
  }
  private assertRouteOptions(input: CreateOrderInput, schema: { shipmentOptions: Array<{ code: string }>; customsMode: string }) {
    const allowed = new Set(schema.shipmentOptions.map((item) => item.code));
    const used: Array<[string, boolean]> = [['taxWith', (input.taxWith ?? 0) !== 0], ['deliveryWith', Boolean(input.deliveryWith)], ['exportWith', (input.exportWith ?? 0) !== 0], ['importWith', (input.importWith ?? 0) !== 0], ['shipmentAttrs', Boolean(input.shipmentAttrs?.length)]];
    for (const [code, value] of used) if (value && !allowed.has(code)) throw new BadRequestException(`当前供应商国家路由未启用字段：${code}`);
    if ((input.taxWith === 3 || input.taxWith === 4) && !input.taxNumber?.trim()) throw new BadRequestException('交税方式为自主税号或自税递延时必须填写税号');
  }
  private normalizeBoxNumbers(boxes: BoxInput[], orderNo: string): Array<BoxInput & { boxNo: string }> {
    const used = new Set(boxes.map((box) => box.boxNo?.trim()).filter((boxNo): boxNo is string => Boolean(boxNo)));
    let sequence = 1;
    return boxes.map((box) => {
      const supplied = box.boxNo?.trim();
      if (supplied) return { ...box, boxNo: supplied };
      let generated = `${orderNo}-${String(sequence).padStart(3, '0')}`;
      while (used.has(generated)) generated = `${orderNo}-${String(++sequence).padStart(3, '0')}`;
      used.add(generated); sequence += 1;
      return { ...box, boxNo: generated };
    });
  }
  private normalizeItem(item: ItemInput) { return { chineseName: item.chineseName?.trim() || null, englishName: item.englishName?.trim() || null, material: item.material?.trim() || null, originCountryCode: item.originCountryCode?.trim().toUpperCase() || null, harmonizedCode: item.harmonizedCode?.trim() || null, quantity: item.quantity ?? null, unitDeclaredValue: item.unitDeclaredValue?.trim() || null, declaredValueCurrency: item.declaredValueCurrency ?? null, sku: item.sku?.trim() || null, itemWeightKg: item.itemWeightKg?.trim() || null, itemLengthCm: item.itemLengthCm?.trim() || null, itemWidthCm: item.itemWidthCm?.trim() || null, itemHeightCm: item.itemHeightCm?.trim() || null }; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`; }
}
