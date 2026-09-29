// Run AFTER tsc, including inside the Linux image. Never contacts UPS or the DB.
require('reflect-metadata');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { UpsLabelService } = require('../dist/orders/ups-label.service');
const { UpsShipmentService } = require('../dist/orders/ups-shipment.service');
const { OrdersService } = require('../dist/orders/orders.service');
const { ShipmentOperationsService } = require('../dist/orders/shipment-operations.service');
const { ShipmentDispatchQueueService } = require('../dist/open-api/shipment-dispatch-queue.service');

(async () => {
  for (const type of [UpsLabelService, UpsShipmentService, OrdersService, ShipmentOperationsService, ShipmentDispatchQueueService]) {
    const dependencies = Reflect.getMetadata('design:paramtypes', type);
    assert.ok(dependencies?.length > 0 && dependencies.every(Boolean), `${type.name}: missing dependency metadata`);
  }
  const convert = new UpsLabelService({});
  for (const [width, height] of [[400, 600], [600, 400]]) {
    const gif = await sharp({ create: { width, height, channels: 3, background: 'white' } }).gif().toBuffer();
    const data = await convert.toPdf(gif);
    assert.equal(data.subarray(0, 5).toString(), '%PDF-');
    const pdf = await PDFDocument.load(data);
    assert.equal(pdf.getPageCount(), 1);
    assert.deepEqual(pdf.getPage(0).getSize(), { width: 288, height: 432 });
  }
  console.log('PASS: compiled DI metadata and portrait/landscape GIF to 4x6 PDF; no network or database calls');
})().catch(error => { console.error(error); process.exitCode = 1; });
