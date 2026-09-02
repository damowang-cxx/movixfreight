import { BadRequestException, Injectable } from '@nestjs/common';
import type { Order, OrderBox, OrderItemDeclaration, Service, Supplier } from '@prisma/client';
import { FedexRelayConfig } from './fedex-relay.config';
import { SettingsService } from '../settings/settings.service';

type FedexOrder = Order & { service: Service & { supplier: Pick<Supplier, 'code' | 'driverCode'> }; boxes: Array<OrderBox & { items: OrderItemDeclaration[] }> };

@Injectable()
export class FedexRelayMapper {
  constructor(private readonly config: FedexRelayConfig, private readonly settings: SettingsService) {}

  async buildShipment(order: FedexOrder) {
    this.config.assertReady(order.service.supplier.code);
    if (!order.service.carrierServiceType) throw new BadRequestException('服务尚未配置 FedEx serviceType');
    if (!order.recipientCity || !order.recipientAddressLine1 || !order.recipientPhone) throw new BadRequestException('收件人城市、地址和电话为 FedEx 打单必填字段');
    const connection = this.config.connection(order.service.supplier.code);
    const shipper = connection.shipper!;
    const labelSpecification = await this.settings.carrierLabelSpecification(order.service.supplierId, order.service.supplier.driverCode);
    const international = shipper.countryCode !== order.recipientCountryCode;
    const requestedShipment: Record<string, unknown> = {
      shipDatestamp: new Date().toISOString().slice(0, 10), serviceType: order.service.carrierServiceType, packagingType: 'YOUR_PACKAGING', pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      shipper: { contact: { personName: shipper.name, companyName: shipper.company, phoneNumber: shipper.phone }, address: { streetLines: shipper.streetLines, city: shipper.city, postalCode: shipper.postalCode, countryCode: shipper.countryCode } },
      recipients: [{ contact: { personName: order.recipientName, companyName: order.recipientCompany ?? order.recipientName, phoneNumber: order.recipientPhone }, address: { streetLines: [order.recipientAddressLine1, order.recipientAddressLine2, order.recipientAddressLine3].filter((line): line is string => Boolean(line)), city: order.recipientCity, postalCode: order.recipientPostcode, countryCode: order.recipientCountryCode, residential: order.recipientResidential, ...(order.recipientState ? { stateOrProvinceCode: order.recipientState } : {}) } }],
      shippingChargesPayment: { paymentType: 'SENDER' }, labelSpecification,
      requestedPackageLineItems: order.boxes.map((box, index) => ({ sequenceNumber: String(index + 1), groupPackageCount: 1, weight: { units: 'KG', value: Number(box.weightKg) }, dimensions: { length: Number(box.lengthCm), width: Number(box.widthCm), height: Number(box.heightCm), units: 'CM' }, customerReferences: [{ customerReferenceType: 'CUSTOMER_REFERENCE', value: order.orderNo }] })),
    };
    if (international) requestedShipment.customsClearanceDetail = this.customs(order);
    return { labelResponseOptions: 'LABEL', accountNumber: { value: connection.fedexAccountNumber }, requestedShipment };
  }

  private customs(order: FedexOrder) {
    const items = order.boxes.flatMap((box) => box.items);
    if (!items.length || items.some((item) => !item.englishName || !item.originCountryCode || !item.harmonizedCode || !item.quantity || !item.unitDeclaredValue || !item.declaredValueCurrency)) {
      throw new BadRequestException('跨境 FedEx 打单要求每条申报货品填写英文品名、原产国、HS 编码、数量、单件申报货值和申报币种');
    }
    const currencies = [...new Set(items.map((item) => item.declaredValueCurrency!))];
    if (currencies.length !== 1) throw new BadRequestException('跨境 FedEx 首期不支持同票多种申报币种');
    const currency = currencies[0]!;
    const total = items.reduce((sum, item) => sum + Number(item.unitDeclaredValue!) * item.quantity!, 0);
    return { dutiesPayment: { paymentType: 'SENDER' }, documentContent: 'NON_DOCUMENTS', customsValue: { amount: total, currency }, commodities: items.map((item) => ({ description: item.englishName!, countryOfManufacture: item.originCountryCode!, harmonizedCode: item.harmonizedCode!, quantity: item.quantity!, quantityUnits: 'PCS', unitPrice: { amount: Number(item.unitDeclaredValue!), currency }, customsValue: { amount: Number(item.unitDeclaredValue!) * item.quantity!, currency }, weight: { units: 'KG', value: 1 } })), commercialInvoice: { shipmentPurpose: 'SOLD' } };
  }
}
