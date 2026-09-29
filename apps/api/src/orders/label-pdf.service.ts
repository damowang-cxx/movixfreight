import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

/**
 * FedEx can return a 4 x 6 label drawn inside a Letter-size PDF.  A browser
 * faithfully shows that Letter canvas, which leaves most of the preview and
 * printed page blank.  We retain the original bytes in ShipmentLabel, and
 * only reframe this known FedEx layout when returning a PDF to a user.
 */
@Injectable()
export class LabelPdfService {
  private readonly logger = new Logger(LabelPdfService.name);

  private static readonly POINTS_PER_INCH = 72;
  private static readonly LABEL_WIDTH = 4 * LabelPdfService.POINTS_PER_INCH;
  private static readonly LABEL_HEIGHT = 6 * LabelPdfService.POINTS_PER_INCH;
  // FedEx laser-label PDFs place the printable region near the upper-left
  // corner of a US Letter page.  The source frame is deliberately a little
  // wider than 4 inches so edge text is not trimmed before it is scaled.
  private static readonly SOURCE_LEFT = 24;
  private static readonly SOURCE_BOTTOM = 324;
  private static readonly SOURCE_WIDTH = 300;
  // Keep a physical print-safe border inside the final 4 x 6 stock.  This is
  // intentionally small enough that barcodes remain comfortably legible.
  private static readonly PRINT_SAFE_MARGIN = 2 / 25.4 * LabelPdfService.POINTS_PER_INCH;

  async forPreviewOrDownload(content: Uint8Array, contentType: string | null | undefined, driverCode = 'FEDEX_RELAY'): Promise<Buffer> {
    const source = Buffer.from(content);
    if (driverCode !== 'FEDEX_RELAY' || !this.isPdf(source, contentType)) return source;

    try {
      const document = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
      const output = await PDFDocument.create();
      let reframed = false;

      for (const page of document.getPages()) {
        const mediaBox = page.getMediaBox();
        if (!this.isFedexLetterCanvas(mediaBox.width, mediaBox.height)) {
          const [copied] = await output.copyPages(document, [document.getPages().indexOf(page)]);
          output.addPage(copied);
          continue;
        }

        const x = mediaBox.x + LabelPdfService.SOURCE_LEFT;
        const y = mediaBox.y + LabelPdfService.SOURCE_BOTTOM;
        const label = await output.embedPage(page, { left: x, bottom: y, right: x + LabelPdfService.SOURCE_WIDTH, top: y + LabelPdfService.LABEL_HEIGHT });
        const outputPage = output.addPage([LabelPdfService.LABEL_WIDTH, LabelPdfService.LABEL_HEIGHT]);
        const margin = LabelPdfService.PRINT_SAFE_MARGIN;
        const scale = Math.min(
          (LabelPdfService.LABEL_WIDTH - margin * 2) / LabelPdfService.SOURCE_WIDTH,
          (LabelPdfService.LABEL_HEIGHT - margin * 2) / LabelPdfService.LABEL_HEIGHT,
        );
        const width = LabelPdfService.SOURCE_WIDTH * scale;
        const height = LabelPdfService.LABEL_HEIGHT * scale;
        outputPage.drawPage(label, {
          x: (LabelPdfService.LABEL_WIDTH - width) / 2,
          y: (LabelPdfService.LABEL_HEIGHT - height) / 2,
          width,
          height,
        });
        reframed = true;
      }

      return reframed ? Buffer.from(await output.save({ useObjectStreams: false, updateFieldAppearances: false })) : source;
    } catch (error) {
      // A malformed provider PDF must remain downloadable for troubleshooting.
      this.logger.warn(`未能裁切面单 PDF，将返回供应商原文件：${error instanceof Error ? error.message : String(error)}`);
      return source;
    }
  }

  private isPdf(content: Buffer, contentType: string | null | undefined) {
    return Boolean(contentType?.toUpperCase().includes('PDF')) || content.subarray(0, 4).toString('ascii') === '%PDF';
  }

  private isFedexLetterCanvas(width: number, height: number) {
    // Do not touch labels already supplied at their actual size (for example
    // a genuine 4 x 6 PDF) or a future provider-specific paper format.
    return Math.abs(width - 612) <= 2 && Math.abs(height - 792) <= 2;
  }
}
