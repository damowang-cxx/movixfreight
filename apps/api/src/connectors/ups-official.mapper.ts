import { BadRequestException } from '@nestjs/common';
import { UPS_EU_COUNTRIES } from './connector-drivers.registry';
import { UpsProfile } from './ups-official.config';
import { normalizeRecipientAddress } from '../orders/recipient-address';

export function assertUpsInput(input: any) {
  const fail = (s: string): never => { throw new BadRequestException(s); };
  if (!UPS_EU_COUNTRIES.includes(input.recipientCountryCode)) fail('UPS 首期仅支持荷兰发往已配置欧盟国家');
  // EU membership alone does not imply common customs territory. Exclude known special territories.
  const zip = String(input.recipientPostcode ?? '').replace(/\s/g, '').toUpperCase();
  const country = input.recipientCountryCode;
  if ((country === 'ES' && /^(35|38|51|52)/.test(zip)) || (country === 'FI' && /^22/.test(zip)) || (country === 'IT' && /^(23041|22061)$/.test(zip)) || (country === 'DE' && /^(27498|78266)$/.test(zip)) || (country === 'GR' && /^63086$/.test(zip)) || (country === 'FR' && /^(97|98)/.test(zip))) fail('该目的地属于特殊税务/清关区域，本期 UPS 无清关线路不支持');
  const text = (key: string, label: string, max: number, required = true) => {
    const v = String(input[key] ?? '').trim();
    if ((required && !v) || Array.from(v).length > max || /[\u0000-\u001f]/.test(v)) fail(`${label}不能为空且不能超过 ${max} 字符（省/州、公司可选）`);
  };
  text('recipientName', '收件人', 35); text('recipientCompany', '公司', 35, false); text('recipientCity', '城市', 30); text('recipientState', '省/州', 5, country === 'IE'); text('recipientPostcode', '邮编', 9);
  const phone = String(input.recipientPhone ?? '').replace(/[ +()\-]/g, '');
  if (!/^\d{6,15}$/.test(phone)) fail('UPS 收件电话需为 6–15 位数字，可包含 +、空格和括号');
  normalizeRecipientAddress([input.recipientAddressRaw ?? input.recipientAddress ?? input.recipientAddressLine1, ...(input.recipientAddressRaw || input.recipientAddress ? [] : [input.recipientAddressLine2, input.recipientAddressLine3])], 'UPS_OFFICIAL');
  if (input.taxWith || input.taxNumber?.trim() || input.deliveryWith || input.exportWith || input.importWith || input.shipmentAttrs?.length) fail('UPS Standard 本期不支持税号、DDP/DDU、报关清关或特殊物品选项');
  if (!input.boxes?.length || input.boxes.length > 200) fail('UPS 件数必须在 1–200 之间');
  for (const box of input.boxes) {
    if ([box.weightKg, box.lengthCm, box.widthCm, box.heightCm].some(v => !Number.isFinite(Number(v)) || Number(v) <= 0)) fail('UPS 每箱重量和长宽高必须大于零');
    if (Number(box.weightKg) > 70) fail('UPS 普通包裹每箱不能超过 70 kg');
    const [l, w, h] = [box.lengthCm, box.widthCm, box.heightCm].map(Number).sort((a, b) => b - a);
    if (l > 274 || l + 2 * (w + h) > 400) fail('UPS 包裹最长边不能超过 274 cm，长加围长不能超过 400 cm');
    if (!box.items?.length || box.items.some((item: any) => !/^[\x20-\x7E]{1,35}$/.test(String(item.englishName ?? '').trim()))) fail('UPS 每条货品需填写 1–35 字符的可打印英文品名');
    if (box.items.map((item: any) => item.englishName.trim()).join(', ').length > 35) fail(`箱 ${box.boxNo ?? ''} 的英文货品描述合计不能超过 35 字符，请精简品名`);
  }
}

export function buildUpsShipment(order: any, p: UpsProfile) {
  assertUpsInput(order);
  const snapshot = order.supplierRouteSnapshot;
  if (snapshot?.carrierServiceType !== '11' || snapshot?.fieldSchema?.customsMode !== 'NONE') throw new BadRequestException('UPS 订单缺少有效的 Standard 无清关路由快照');
  const address = normalizeRecipientAddress([order.recipientAddressRaw ?? order.recipientAddressLine1, ...(order.recipientAddressRaw ? [] : [order.recipientAddressLine2, order.recipientAddressLine3])], 'UPS_OFFICIAL');
  const shipper = { Name: p.shipper.company, AttentionName: p.shipper.name, Phone: { Number: p.shipper.phone.replace(/\D/g, '') }, Address: { AddressLine: p.shipper.streetLines, City: p.shipper.city, PostalCode: p.shipper.postalCode.replace(/\s/g, ''), CountryCode: 'NL', ...(p.shipper.stateCode ? { StateProvinceCode: p.shipper.stateCode } : {}) } };
  return { ShipmentRequest: {
    Request: { RequestOption: 'validate', TransactionReference: { CustomerContext: order.orderNo } },
    Shipment: {
      Description: 'Goods', Shipper: { ...shipper, ShipperNumber: p.shipperNumber }, ShipFrom: shipper,
      ShipTo: { Name: order.recipientCompany || order.recipientName, AttentionName: order.recipientName, Phone: { Number: order.recipientPhone.replace(/\D/g, '') }, Address: { AddressLine: address.lines, City: order.recipientCity, CountryCode: order.recipientCountryCode, PostalCode: order.recipientPostcode.replace(/\s/g, ''), ...(order.recipientState ? { StateProvinceCode: order.recipientState } : {}), ...(order.recipientResidential ? { ResidentialAddressIndicator: '' } : {}) } },
      PaymentInformation: { ShipmentCharge: { Type: '01', BillShipper: { AccountNumber: p.shipperNumber } } }, Service: { Code: '11' },
      Package: order.boxes.map((box: any) => ({ Description: box.items.map((i: any) => i.englishName.trim()).join(', '), Packaging: { Code: '02' }, Dimensions: { UnitOfMeasurement: { Code: 'CM' }, Length: String(box.lengthCm), Width: String(box.widthCm), Height: String(box.heightCm) }, PackageWeight: { UnitOfMeasurement: { Code: 'KGS' }, Weight: String(box.weightKg) } })),
    }, LabelSpecification: { LabelImageFormat: { Code: 'GIF' }, HTTPUserAgent: 'MOVIX' },
  } };
}
