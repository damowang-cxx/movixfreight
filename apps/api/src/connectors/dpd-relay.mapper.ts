import { BadRequestException } from '@nestjs/common';
import { Prisma, type Order, type OrderBox, type OrderItemDeclaration } from '@prisma/client';
import type { DpdRelayProfile } from './dpd-relay.config';

type DpdOrder = Order & { boxes: Array<OrderBox & { items: OrderItemDeclaration[] }> };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : String(value ?? '').trim();
const required = (value: unknown, name: string, limit: number) => {
  const result = text(value);
  if (!result || Array.from(result).length > limit) throw new BadRequestException(`DPD ${name} 缺失或超过 ${limit} 字符`);
  return result;
};

export function buildDpdShipment(order: DpdOrder, p: DpdRelayProfile) {
  if (order.recipientCountryCode !== 'GB' || order.boxes.length !== 1) throw new BadRequestException('DPD 英国本土首期仅支持 GB 一票一件');
  const box = order.boxes[0]!;
  const items = box.items;
  if (!items.length || items.some(item => !item.englishName || !item.quantity || !item.unitDeclaredValue || !item.declaredValueCurrency)) throw new BadRequestException('DPD 商品英文名、数量、单价和申报币种不能为空');
  const currencies = [...new Set(items.map(item => item.declaredValueCurrency))];
  if (currencies.length !== 1) throw new BadRequestException('DPD 一票货物只能使用一种申报币种');
  const value = items.reduce((sum, item) => sum.plus(new Prisma.Decimal(item.unitDeclaredValue!).mul(item.quantity!)), new Prisma.Decimal(0));
  const content = required(items.map(item => item.englishName).join(', '), '货物内容', 150);
  const recipientPhone = required(order.recipientPhone, '收件电话', 40);
  const productCode = required((order.supplierRouteSnapshot as any)?.carrierServiceType, '路由 ProductCode', 5);
  const address1 = required(order.recipientAddressLine1, '收件地址第一行', 30);
  const address2 = order.recipientAddressLine2 ? required(order.recipientAddressLine2, '收件地址第二行', 30) : '';
  if (order.recipientAddressLine3) throw new BadRequestException('DPD 收件地址最多两行');
  return {
    UserID: p.userId, Password: p.password, CustomerCode: p.customerCode,
    CustomerRefNo: required(order.orderNo, '客户参考号', 30), OriginName: required(p.shipper.name, 'OriginName 发件公司名', 30), DestinationName: required(order.recipientName, 'DestinationName 收件人姓名', 30),
    ShipperName: required(p.shipper.name, '发件人名称', 40), ShipperContact: p.shipper.contact,
    ShipperAdd1: p.shipper.address1, ShipperAdd2: p.shipper.address2 ?? '', ShipperCity: p.shipper.city,
    ShipperState: p.shipper.state ?? '', ShipperPin: p.shipper.postcode, ShipperTelno: p.shipper.telephone,
    ShipperMobile: p.shipper.mobile ?? '', ShipperEmail: p.shipper.email ?? '',
    ConsigneeName: required(order.recipientName, '收件人名称', 40), ConsigneeContact: required(order.recipientName, '收件联系人', 40),
    ConsigneeAdd1: address1, ConsigneeAdd2: address2, ConsigneeCity: required(order.recipientCity, '收件城市', 30),
    ConsigneeState: order.recipientState ?? '', ConsigneePin: required(order.recipientPostcode, '收件邮编', 10),
    ConsigneeTelno: recipientPhone, ConsigneeMobile: recipientPhone,
    VendorName: p.vendorName, ServiceName: p.serviceName, ProductCode: productCode,
    Dox_Spx: 'SPX', Pieces: '1', Weight: box.weightKg.toFixed(3), Content: content,
    Currency: currencies[0], ShipmentValue: value.toFixed(2), CODAmount: '0.00',
    RequiredLable: 'Y', RequiredPerforma: 'N',
    Dimensions: [{ ActualWeight: box.weightKg.toFixed(3), Vol_WeightL: box.lengthCm.toFixed(3), Vol_WeightW: box.widthCm.toFixed(3), Vol_WeightH: box.heightCm.toFixed(3) }],
    Performa: items.map(item => ({ BoxNo: 'Box-1', Description: required(item.englishName, '商品英文名', 50), HSNCode: item.harmonizedCode ?? '', Quantity: String(item.quantity), Unit: 'PCS', Rate: item.unitDeclaredValue!.toFixed(2), Amount: new Prisma.Decimal(item.unitDeclaredValue!).mul(item.quantity!).toFixed(2), Weight: item.itemWeightKg?.toFixed(3) ?? '' })),
  };
}

export function dpdSuccess(body: any) { return body?.ResponseCode === 'RT01' && String(body?.ErrorCode) === '0' && String(body?.Status).toLowerCase() === 'success'; }
export function dpdRejection(body: any) {
  const errors = Array.isArray(body?.Response?.Error) ? body.Response.Error : [];
  const messages = errors.map((item: any) => String(item?.Description ?? item?.Message ?? '').trim()).filter(Boolean).slice(0, 5);
  const status = String(body?.Response?.Status ?? body?.Status ?? '').trim();
  const code = body?.ErrorCode ?? body?.Response?.ErrorCode;
  return { explicit: messages.length > 0 || (code !== undefined && String(code) !== '0') || /^(fail|failed|failure|error|rejected)$/i.test(status) || Boolean(String(body?.APIError ?? body?.Response?.APIError ?? '').trim()), messages };
}
export function dpdPdf(body: any): Buffer | null {
  const raw = typeof body?.Pdfdownload === 'string' ? body.Pdfdownload.trim().replace(/^data:application\/pdf;base64,/i, '').replace(/\s+/g, '') : '';
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64');
  return bytes.subarray(0, 4).toString('ascii') === '%PDF' ? bytes : null;
}
