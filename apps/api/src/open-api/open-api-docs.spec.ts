import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenApiDocsController } from './open-api-docs.controller';

test('public integration page documents only current Open API contracts', () => {
  let html = '';
  new OpenApiDocsController().document({ send: (value: string) => { html = value; } } as any);
  for (const item of [
    'Idempotency-Key',
    'shipment.service',
    'id="fields"',
    'declarations[]',
    '/shipments/:shipmentId/label/download',
    '/shipments/:shipmentId/tracking',
    'ORDER_CREATION_FORBIDDEN',
    'LABEL_PROCESSING_FAILED',
  ]) assert.ok(html.includes(item), `missing ${item}`);
  assert.ok(!html.includes('INSUFFICIENT_BALANCE'));
  assert.ok(!html.includes('href="/api/docs"'));
  assert.ok(!html.includes('FEDEX_REGIONAL_ECONOMY'));
  const jsonExamples = [...html.matchAll(/<pre[^>]*>({[\s\S]*?})<\/pre>/g)];
  assert.ok(jsonExamples.length >= 5);
  for (const [, source] of jsonExamples) assert.doesNotThrow(() => JSON.parse(source!));
});
