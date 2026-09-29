import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
// Sharp's CJS entry is callable; this API compiles without esModuleInterop.
const sharp: typeof import('sharp').default = require('sharp');
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class UpsLabelService {
  constructor(private readonly prisma: PrismaService) {}
  async toPdf(source: Uint8Array) {
    const bytes = Buffer.from(source);
    if (!['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) throw new Error('UPS 原始标签不是有效 GIF');
    // Decode only one image; reject animated/oversized input and never crop a barcode.
    const metadata = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata();
    if ((metadata.pages ?? 1) !== 1) throw new Error('不支持多帧 UPS GIF');
    const png = await sharp(bytes, { limitInputPixels: 16_000_000 }).rotate((metadata.width ?? 0) > (metadata.height ?? 0) ? 90 : 0).png().toBuffer();
    const pdf = await PDFDocument.create(); const image = await pdf.embedPng(png);
    const page = pdf.addPage([288, 432]); const margin = 2 / 25.4 * 72;
    const scale = Math.min((288 - margin * 2) / image.width, (432 - margin * 2) / image.height);
    page.drawImage(image, { x: (288 - image.width * scale) / 2, y: (432 - image.height * scale) / 2, width: image.width * scale, height: image.height * scale });
    return Buffer.from(await pdf.save());
  }
  /** Idempotent local-only repair. Never calls UPS Shipping, including after process crashes. */
  async ensure<T extends { id: string; contentType: string; content: Uint8Array; sourceContent?: Uint8Array | null }>(label: T): Promise<T> {
    if (!label.sourceContent || label.contentType === 'application/pdf') return label;
    try {
      const content = await this.toPdf(label.sourceContent);
      const saved = await this.prisma.shipmentLabel.update({ where: { id: label.id }, data: { content, contentType: 'application/pdf' } });
      const remaining = await this.prisma.shipmentLabel.count({ where: { orderId: saved.orderId, sourceContent: { not: null }, contentType: { not: 'application/pdf' } } });
      if (!remaining) await this.prisma.shipmentDispatchJob.updateMany({ where: { orderId: saved.orderId, order: { shipmentStatus: 'GENERATED' } }, data: { status: 'COMPLETED', stage: 'READY', reasonCode: 'LABEL_READY', publicMessage: '面单已生成，可预览或下载 PDF', errorMessage: null, completedAt: new Date() } });
      return { ...label, content, contentType: 'application/pdf' };
    } catch { throw new ServiceUnavailableException({ code: 'LABEL_PROCESSING_FAILED', message: '运单已生成，PDF 处理失败；可再次预览/下载仅重做本地转换，不会重新打单' }); }
  }
}
