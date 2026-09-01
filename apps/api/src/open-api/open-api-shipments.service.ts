import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { PricingService } from '../pricing/pricing.service';
import { ShipmentDispatchQueueService } from './shipment-dispatch-queue.service';
import type { OpenApiPrincipal } from './open-api-auth.guard';
import type { CreateOpenShipmentDto, OpenAddressDto, OpenShipmentDto } from './dto/create-open-shipment.dto';
import { normalizeRecipientAddress } from '../orders/recipient-address';

const ENGLISH_COUNTRIES: Record<string, string> = {
  austria: 'AT', belgium: 'BE', bulgaria: 'BG', china: 'CN', croatia: 'HR', czechia: 'CZ', 'czech republic': 'CZ', denmark: 'DK', estonia: 'EE', finland: 'FI', france: 'FR', germany: 'DE', greece: 'GR', hungary: 'HU', ireland: 'IE', italy: 'IT', latvia: 'LV', lithuania: 'LT', luxembourg: 'LU', netherlands: 'NL', norway: 'NO', poland: 'PL', portugal: 'PT', romania: 'RO', slovakia: 'SK', slovenia: 'SI', spain: 'ES', sweden: 'SE', switzerland: 'CH', 'united kingdom': 'GB', uk: 'GB', england: 'GB', 'great britain': 'GB',
};

@Injectable()
export class OpenApiShipmentsService {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrdersService, private readonly pricing: PricingService, private readonly dispatchQueue: ShipmentDispatchQueueService) {}

  async create(customer: OpenApiPrincipal, idempotencyKey: string | undefined, input: CreateOpenShipmentDto) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('缺少 Idempotency-Key 请求头');
    if (idempotencyKey.length > 256) throw new BadRequestException('Idempotency-Key 不能超过 256 个字符');
    const keyHash = this.hash(idempotencyKey);
    const requestHash = this.hash(this.canonical(input));
    const existing = await this.prisma.openApiIdempotencyRecord.findUnique({ where: { customerId_idempotencyKeyHash: { customerId: customer.customerId, idempotencyKeyHash: keyHash } }, include: { order: { include: { dispatchJob: true } } } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ConflictException('同一 Idempotency-Key 对应的请求内容不一致');
      return this.accepted(existing.order);
    }

    const normalized = await this.normalizeShipment(input.shipment);
    const service = await this.prisma.service.findUnique({ where: { code: normalized.serviceCode }, include: { supplier: true } });
    if (!service?.enabled || !service.supplier.enabled) throw new NotFoundException('服务不存在、已停用或供应商连接不可用');
    if (service.supplier.driverCode !== 'FEDEX_RELAY') throw new UnprocessableEntityException('当前服务暂不支持 Open API 自动生成面单');
    this.assertFedexSupportedOptions(normalized);

    const order = await this.orders.createForCustomer(customer.customerId, {
      idempotencyKey: `open-${customer.customerId}-${keyHash}`,
      serviceId: service.id,
      recipientName: normalized.toAddress.name!,
      recipientCompany: normalized.toAddress.company,
      recipientPhone: normalized.toAddress.mobile ?? normalized.toAddress.tel,
      recipientCountryCode: normalized.destinationCountryCode,
      recipientPostcode: normalized.toAddress.postcode!,
      recipientCity: normalized.toAddress.city!,
      recipientAddress: normalized.recipientAddress.raw,
      estimatedChargeableKg: normalized.estimatedChargeableKg,
      clientReference: normalized.clientReference,
      taxWith: normalized.taxWith,
      taxNumber: normalized.taxNumber,
      deliveryWith: normalized.deliveryWith,
      exportWith: normalized.exportWith,
      importWith: normalized.importWith,
      shipmentAttrs: normalized.attrs,
      fromAddress: normalized.fromAddress,
      toAddress: normalized.toAddress,
      boxes: normalized.boxes,
    });

    try {
      await this.prisma.$transaction([
        this.prisma.openApiIdempotencyRecord.create({ data: { customerId: customer.customerId, idempotencyKeyHash: keyHash, requestHash, orderId: order.id } }),
        this.prisma.shipmentDispatchJob.upsert({ where: { orderId: order.id }, update: {}, create: { orderId: order.id } }),
      ]);
    } catch (error) {
      const recovered = await this.prisma.openApiIdempotencyRecord.findUnique({ where: { customerId_idempotencyKeyHash: { customerId: customer.customerId, idempotencyKeyHash: keyHash } }, include: { order: { include: { dispatchJob: true } } } });
      if (recovered) {
        if (recovered.requestHash !== requestHash) throw new ConflictException('同一 Idempotency-Key 对应的请求内容不一致');
        return this.accepted(recovered.order);
      }
      throw error;
    }
    await this.dispatchQueue.enqueue(order.id).catch(() => undefined);
    const accepted = await this.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { dispatchJob: true } });
    return this.accepted(accepted);
  }

  async label(customer: OpenApiPrincipal, shipmentId: string) {
    const order = await this.loadOwned(customer.customerId, shipmentId, true);
    const status = this.labelStatus(order);
    const base = `/api/open/v1/shipments/${encodeURIComponent(order.orderNo)}/label`;
    return { shipment: { shipment_id: order.orderNo, client_reference: order.clientReference, label_status: status, transfer_number: status === 'READY' ? order.carrierTrackingNumber : null, label_count: order.labels.length, labels: status === 'READY' ? order.labels.map((label) => ({ label_id: label.id, tracking_number: label.trackingNumber ?? order.carrierTrackingNumber, download_url: `${base}/download?label_id=${encodeURIComponent(label.id)}` })) : [], label_download_url: `${base}/download`, failure_reason: status === 'FAILED' || status === 'UNKNOWN' ? order.dispatchJob?.errorMessage ?? '供应商面单生成失败' : null } };
  }

  async labelFile(customer: OpenApiPrincipal, shipmentId: string, labelId?: string) {
    const order = await this.loadOwned(customer.customerId, shipmentId, true);
    if (this.labelStatus(order) !== 'READY') throw new ConflictException('面单尚未就绪');
    if (order.labels.length > 1 && !labelId) throw new ConflictException('该票订单包含多个面单，请从标签状态接口返回的 labels 中选择 label_id 下载');
    const label = labelId ? order.labels.find((item) => item.id === labelId) : order.labels[0];
    if (!label) throw new NotFoundException('面单不存在');
    return label;
  }

  private async loadOwned(customerId: string, shipmentId: string, includeLabels: boolean) {
    const order = await this.prisma.order.findFirst({ where: { customerId, orderNo: shipmentId }, include: { dispatchJob: true, ...(includeLabels ? { labels: { select: { id: true, trackingNumber: true, contentType: true, content: true, createdAt: true } } } : {}) } });
    if (!order) throw new NotFoundException('运单不存在或无权访问');
    return order as typeof order & { labels: Array<{ id: string; trackingNumber: string | null; contentType: string; content: Buffer; createdAt: Date }> };
  }

  private async normalizeShipment(shipment: OpenShipmentDto) {
    const toAddress = this.cleanAddress(shipment.to_address);
    const recipientAddress = normalizeRecipientAddress([toAddress.address_1, toAddress.address_2, toAddress.address_3]);
    this.assertRecipient(toAddress);
    const destinationCountryCode = await this.countryCode(toAddress.country!);
    toAddress.country = destinationCountryCode;
    const fromAddress = shipment.from_address ? this.cleanAddress(shipment.from_address) : undefined;
    if (fromAddress?.country) fromAddress.country = await this.countryCode(fromAddress.country);
    if (shipment.parcel_count !== shipment.parcels.length) throw new BadRequestException('parcel_count 必须与 parcels 数量一致');
    if (!shipment.parcels.length) throw new BadRequestException('至少需要一个箱子');
    const boxes = await Promise.all(shipment.parcels.map(async (parcel) => {
      if (!parcel.declarations.length) throw new BadRequestException(`箱号 ${parcel.number} 至少需要一条申报明细`);
      const items = await Promise.all(parcel.declarations.map(async (item) => {
        if (!item.name_cn.trim() || !item.name_en.trim()) throw new BadRequestException(`箱号 ${parcel.number} 的申报明细必须填写 name_cn 和 name_en`);
        return {
          chineseName: item.name_cn.trim(), englishName: item.name_en.trim(), material: item.material?.trim() || undefined,
          originCountryCode: item.origin_country ? await this.countryCode(item.origin_country) : undefined,
          harmonizedCode: item.hs_code?.trim() || undefined, quantity: item.quantity,
          unitDeclaredValue: item.unit_price === undefined ? undefined : item.unit_price.toFixed(2), declaredValueCurrency: shipment.declaration_currency,
          sku: item.sku?.trim() || undefined, itemWeightKg: item.weight === undefined ? undefined : String(item.weight),
          itemLengthCm: item.length === undefined ? undefined : String(item.length), itemWidthCm: item.width === undefined ? undefined : String(item.width), itemHeightCm: item.height === undefined ? undefined : String(item.height),
        };
      }));
      return { boxNo: parcel.number.trim(), reference: parcel.reference?.trim() || undefined, weightKg: String(parcel.client_weight), lengthCm: String(parcel.client_length), widthCm: String(parcel.client_width), heightCm: String(parcel.client_height), items };
    }));
    const numbers = boxes.map((box) => box.boxNo); if (numbers.some((value) => !value) || new Set(numbers).size !== numbers.length) throw new BadRequestException('箱号不能为空且不可重复');
    const taxWith = shipment.taxwith ?? 0; const taxNumber = shipment.tax_number?.trim() || undefined;
    if ((taxWith === 3 || taxWith === 4) && !taxNumber) throw new BadRequestException('taxwith 为 3 或 4 时必须填写 tax_number');
    return { serviceCode: shipment.service.trim(), clientReference: shipment.client_reference?.trim() || undefined, taxWith, taxNumber, deliveryWith: shipment.deliverywith ?? '', exportWith: shipment.exportwith ?? 0, importWith: shipment.importwith ?? 0, attrs: [...new Set(shipment.attrs ?? [])], toAddress, fromAddress, recipientAddress, destinationCountryCode, boxes, estimatedChargeableKg: boxes.reduce((sum, box) => sum + Number(box.weightKg), 0).toFixed(3) };
  }

  private assertFedexSupportedOptions(value: Awaited<ReturnType<OpenApiShipmentsService['normalizeShipment']>>) {
    if (value.taxWith !== 0 || value.deliveryWith || value.exportWith !== 0 || value.importWith !== 0 || value.attrs.length) throw new UnprocessableEntityException('当前 FedEx Open API 连接尚未确认税务、交货、报关、清关或物品属性的供应商映射；请使用默认值');
  }

  private cleanAddress(address: OpenAddressDto) { return Object.fromEntries(Object.entries(address).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])) as Record<string, any>; }
  private assertRecipient(address: Record<string, any>) { if (!address.name || !address.city || !address.country || !address.postcode || (!address.address_1 && !address.address_2 && !address.address_3) || (!address.tel && !address.mobile)) throw new BadRequestException('to_address 必须填写 name、city、country、postcode、至少一个地址字段，以及 tel 或 mobile'); }
  private async countryCode(value: string) { const normalized = value.trim(); const countries = await this.pricing.countries(); const chinese = countries.find((country) => country.chineseName === normalized); if (chinese) return chinese.code; const english = ENGLISH_COUNTRIES[normalized.toLowerCase()]; if (english) return english; throw new BadRequestException(`无法识别国家：${value}`); }
  private labelStatus(order: { shipmentStatus: string; labels: unknown[] }) { if (order.shipmentStatus === 'GENERATED' && order.labels.length) return 'READY'; if (order.shipmentStatus === 'FAILED') return 'FAILED'; if (order.shipmentStatus === 'UNKNOWN') return 'UNKNOWN'; return 'PENDING'; }
  private accepted(order: { orderNo: string; clientReference: string | null; dispatchJob?: unknown }) { const base = `/api/open/v1/shipments/${encodeURIComponent(order.orderNo)}/label`; return { shipment: { shipment_id: order.orderNo, client_reference: order.clientReference, label_status: 'PENDING', label_status_url: base, label_download_url: `${base}/download` } }; }
  private hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
  private canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map((item) => this.canonical(item)).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${this.canonical(item)}`).join(',')}}`; return JSON.stringify(value); }
}
