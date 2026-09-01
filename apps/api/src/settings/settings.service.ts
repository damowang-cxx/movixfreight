import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';

export const DECLARATION_FIELDS = [
  { code: 'boxNo', label: '箱号', locked: true, defaultRequired: true },
  { code: 'weightKg', label: '实重 kg', locked: true, defaultRequired: true },
  { code: 'lengthCm', label: '长 cm', locked: true, defaultRequired: true },
  { code: 'widthCm', label: '宽 cm', locked: true, defaultRequired: true },
  { code: 'heightCm', label: '高 cm', locked: true, defaultRequired: true },
  { code: 'chineseName', label: '中文品名', locked: false, defaultRequired: true },
  { code: 'englishName', label: '英文品名', locked: false, defaultRequired: true },
  { code: 'material', label: '材质', locked: false, defaultRequired: false },
  { code: 'originCountryCode', label: '原产国', locked: false, defaultRequired: false },
  { code: 'harmonizedCode', label: 'HS 编码', locked: false, defaultRequired: true },
  { code: 'quantity', label: '数量', locked: false, defaultRequired: true },
  { code: 'unitDeclaredValue', label: '单件申报货值', locked: false, defaultRequired: true },
  { code: 'declaredValueCurrency', label: '申报币种', locked: false, defaultRequired: true },
] as const;

export type DeclarationFieldCode = typeof DECLARATION_FIELDS[number]['code'];
const fedexRequired: DeclarationFieldCode[] = ['englishName', 'originCountryCode', 'harmonizedCode', 'quantity', 'unitDeclaredValue', 'declaredValueCurrency'];

export type LabelTemplateElement = { id: string; type: 'TEXT' | 'FIELD' | 'BARCODE' | 'LOGO'; value: string; xMm: number; yMm: number; widthMm?: number; heightMm?: number; fontSize?: number };
export type LabelTemplateInput = { supplierId: string; name: string; outputFormat: string; labelStockType: string; thermalDpi?: number | null; customElements?: LabelTemplateElement[]; enabled?: boolean; applyToCarrier?: boolean };

const labelOptions = {
  PDF: ['PAPER_4X6', 'PAPER_4X675', 'PAPER_4X8', 'PAPER_4X9'],
  PNG: ['PAPER_4X6', 'PAPER_4X675', 'PAPER_4X8', 'PAPER_4X9'],
  ZPLII: ['STOCK_4X6', 'STOCK_4X8', 'STOCK_4X9'],
  EPL2: ['STOCK_4X6', 'STOCK_4X8', 'STOCK_4X9'],
} as const;

export const labelTemplateCapabilities = (driverCode: string) => ({
  driverCode,
  standardLabelSpecification: driverCode === 'FEDEX_RELAY',
  carrierCustomThermalContent: false,
  supportedOutputFormats: driverCode === 'FEDEX_RELAY' ? Object.keys(labelOptions) : ['PDF'],
  message: driverCode === 'FEDEX_RELAY'
    ? 'FedEx Direct 会透传标准标签规格。自定义热敏文字、图形与坐标尚未确认中转服务的字段透传能力，当前仅用于模板预览，不会随订单下发。'
    : '该供应商驱动尚未实现面单规格下发；模板仅用于预览。',
});

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async me(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, include: { roles: true } });
    if (!admin) throw new NotFoundException('管理员不存在');
    return { id: admin.id, username: admin.username, displayName: admin.displayName, roles: admin.roles.map((item) => item.role), hasAvatar: Boolean(admin.avatarContent), avatarUpdatedAt: admin.updatedAt };
  }

  async avatar(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { avatarContent: true, avatarMimeType: true } });
    if (!admin?.avatarContent || !admin.avatarMimeType) throw new NotFoundException('尚未设置头像');
    return { content: admin.avatarContent, mimeType: admin.avatarMimeType };
  }

  async updateAvatar(adminId: string, mimeType: string, contentBase64: string) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new BadRequestException('头像仅支持 PNG、JPG 或 WebP');
    let content: Buffer; try { content = Buffer.from(contentBase64, 'base64'); } catch { throw new BadRequestException('头像文件无效'); }
    if (!content.length || content.length > 2 * 1024 * 1024) throw new BadRequestException('头像文件必须大于 0 且不超过 2 MB');
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { avatarContent: new Uint8Array(content), avatarMimeType: mimeType } });
    return { uploaded: true };
  }

  async changePassword(adminId: string, currentPassword: string, newPassword: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !(await compare(currentPassword, admin.passwordHash))) throw new ForbiddenException('当前密码错误');
    if (newPassword.length < 8) throw new BadRequestException('新密码至少需要 8 位');
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { passwordHash: await hash(newPassword, 12) } });
    return { changed: true };
  }

  async declarationFields() {
    const saved = await this.prisma.declarationFieldSetting.findMany(); const required = new Map(saved.map((item) => [item.fieldCode, item.required]));
    return {
      fields: DECLARATION_FIELDS.map((field) => ({ ...field, required: field.locked || (required.get(field.code) ?? field.defaultRequired) })),
      driverRequired: { FEDEX_RELAY: fedexRequired },
    };
  }

  async saveDeclarationFields(adminId: string, requiredCodes: string[], isSuperAdmin: boolean) {
    if (!isSuperAdmin) throw new ForbiddenException('仅超级管理员可修改申报信息设置');
    const allowed = new Set(DECLARATION_FIELDS.map((field) => field.code));
    if (requiredCodes.some((code) => !allowed.has(code as DeclarationFieldCode))) throw new BadRequestException('包含未知申报字段');
    const required = new Set([...requiredCodes, ...DECLARATION_FIELDS.filter((field) => field.locked).map((field) => field.code)]);
    await this.prisma.$transaction(DECLARATION_FIELDS.filter((field) => !field.locked).map((field) => this.prisma.declarationFieldSetting.upsert({ where: { fieldCode: field.code }, update: { required: required.has(field.code), updatedByAdminId: adminId }, create: { fieldCode: field.code, required: required.has(field.code), updatedByAdminId: adminId } })));
    return this.declarationFields();
  }

  async requiredDeclarationFields(driverCode?: string) {
    const settings = await this.declarationFields(); const required = new Set(settings.fields.filter((field) => field.required).map((field) => field.code));
    for (const code of settings.driverRequired[driverCode as keyof typeof settings.driverRequired] ?? []) required.add(code);
    return required;
  }

  async labelTemplates() {
    const [templates, suppliers] = await Promise.all([
      this.prisma.carrierLabelTemplate.findMany({ include: { supplier: { include: { carrier: true } } }, orderBy: [{ supplier: { carrier: { name: 'asc' } } }, { updatedAt: 'desc' }] }),
      this.prisma.supplier.findMany({ select: { driverCode: true } }),
    ]);
    return { templates, capabilities: [...new Set(suppliers.map((item) => item.driverCode))].map(labelTemplateCapabilities) };
  }

  async createLabelTemplate(adminId: string, input: LabelTemplateInput, isSuperAdmin: boolean) {
    this.assertSuperAdmin(isSuperAdmin);
    const normalized = await this.normalizeLabelTemplate(input);
    return this.prisma.$transaction(async (tx) => {
      if (normalized.applyToCarrier) await tx.carrierLabelTemplate.updateMany({ where: { supplierId: normalized.supplierId }, data: { applyToCarrier: false } });
      return tx.carrierLabelTemplate.create({ data: normalized });
    });
  }

  async updateLabelTemplate(templateId: string, adminId: string, input: LabelTemplateInput, isSuperAdmin: boolean) {
    this.assertSuperAdmin(isSuperAdmin);
    const existing = await this.prisma.carrierLabelTemplate.findUnique({ where: { id: templateId } });
    if (!existing) throw new NotFoundException('面单模板不存在');
    const normalized = await this.normalizeLabelTemplate(input);
    return this.prisma.$transaction(async (tx) => {
      if (normalized.applyToCarrier) await tx.carrierLabelTemplate.updateMany({ where: { supplierId: normalized.supplierId, id: { not: templateId } }, data: { applyToCarrier: false } });
      return tx.carrierLabelTemplate.update({ where: { id: templateId }, data: normalized });
    });
  }

  async carrierLabelSpecification(supplierId: string, driverCode: string) {
    const template = await this.prisma.carrierLabelTemplate.findFirst({ where: { supplierId, enabled: true, applyToCarrier: true }, orderBy: { updatedAt: 'desc' } });
    if (!template) return { imageType: 'PDF', labelStockType: 'PAPER_4X6', labelFormatType: 'COMMON2D' };
    if (!labelTemplateCapabilities(driverCode).standardLabelSpecification) return { imageType: 'PDF', labelStockType: 'PAPER_4X6', labelFormatType: 'COMMON2D' };
    return { imageType: template.outputFormat, labelStockType: template.labelStockType, labelFormatType: 'COMMON2D' };
  }

  private assertSuperAdmin(isSuperAdmin: boolean) { if (!isSuperAdmin) throw new ForbiddenException('仅超级管理员可维护面单模板'); }

  private async normalizeLabelTemplate(input: LabelTemplateInput): Promise<Prisma.CarrierLabelTemplateUncheckedCreateInput> {
    const supplierId = String(input.supplierId ?? '').trim(); const name = String(input.name ?? '').trim(); const outputFormat = String(input.outputFormat ?? '').trim().toUpperCase(); const labelStockType = String(input.labelStockType ?? '').trim().toUpperCase();
    if (!supplierId || !name) throw new BadRequestException('请选择供应商连接并填写模板名称');
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, driverCode: true } });
    if (!supplier) throw new BadRequestException('供应商连接不存在');
    if (!(outputFormat in labelOptions) || !(labelOptions[outputFormat as keyof typeof labelOptions] as readonly string[]).includes(labelStockType)) throw new BadRequestException('面单输出格式与标签规格不匹配');
    const thermal = outputFormat === 'ZPLII' || outputFormat === 'EPL2'; const thermalDpi = input.thermalDpi == null ? null : Number(input.thermalDpi);
    if (thermal && thermalDpi !== 203 && thermalDpi !== 300) throw new BadRequestException('热敏模板仅支持 203 或 300 DPI');
    if (!thermal && thermalDpi != null) throw new BadRequestException('PDF/PNG 模板不应设置热敏 DPI');
    const elements = this.normalizeLabelElements(input.customElements ?? []);
    if (elements.length && !(thermal && ['STOCK_4X8', 'STOCK_4X9'].includes(labelStockType))) throw new BadRequestException('自定义图文仅允许 4×8 或 4×9 热敏模板');
    const applyToCarrier = Boolean(input.applyToCarrier);
    if (applyToCarrier && !labelTemplateCapabilities(supplier.driverCode).standardLabelSpecification) throw new BadRequestException('该供应商驱动尚不支持下发面单规格');
    if (applyToCarrier && elements.length) throw new BadRequestException('当前供应商尚未确认热敏自定义图文透传能力；请保留为仅预览模板');
    return { supplierId, name, outputFormat, labelStockType, thermalDpi, customElements: elements as Prisma.InputJsonValue, enabled: input.enabled !== false, applyToCarrier };
  }

  private normalizeLabelElements(input: LabelTemplateElement[]) {
    if (!Array.isArray(input) || input.length > 20) throw new BadRequestException('模板元素数量必须在 0 到 20 之间');
    return input.map((item, index) => {
      const type = String(item.type ?? '').toUpperCase(); const value = String(item.value ?? '').trim(); const xMm = Number(item.xMm); const yMm = Number(item.yMm); const widthMm = item.widthMm == null ? undefined : Number(item.widthMm); const heightMm = item.heightMm == null ? undefined : Number(item.heightMm); const fontSize = item.fontSize == null ? undefined : Number(item.fontSize);
      if (!['TEXT', 'FIELD', 'BARCODE', 'LOGO'].includes(type) || !value) throw new BadRequestException(`第 ${index + 1} 个模板元素无效`);
      if (![xMm, yMm, widthMm, heightMm, fontSize].filter((value) => value !== undefined).every((value) => Number.isFinite(value!) && value! >= 0)) throw new BadRequestException(`第 ${index + 1} 个模板元素坐标或尺寸无效`);
      if (xMm > 114.3 || yMm > 50.8 || (widthMm != null && widthMm > 114.3) || (heightMm != null && heightMm > 50.8)) throw new BadRequestException(`第 ${index + 1} 个元素超出 FedEx 自定义区域（最大 114.3 × 50.8 mm）`);
      return { id: String(item.id ?? `element-${index + 1}`), type, value, xMm, yMm, ...(widthMm == null ? {} : { widthMm }), ...(heightMm == null ? {} : { heightMm }), ...(fontSize == null ? {} : { fontSize }) };
    });
  }
}
