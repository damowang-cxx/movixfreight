import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { FedexValidationService } from './fedex-validation.service';

function fixture(boxCount: number) {
  const calls: string[] = [];
  const order: any = {
    id: 'order-1', shipmentStatus: ShipmentStatus.SUBMITTED, supplierRouteSnapshot: null,
    service: { supplier: { id: 'supplier-1', code: 'fedex-1', driverCode: 'FEDEX_RELAY', enabled: true, environment: 'PRODUCTION' } },
    boxes: Array.from({ length: boxCount }, () => ({})),
  };
  const payload = { requestedShipment: { totalPackageCount: boxCount } };
  const prisma: any = {
    order: {
      findUnique: async () => order,
      updateMany: async () => { calls.push('claim'); return { count: 1 }; },
      update: async () => { calls.push('saved'); },
    },
    connectorCallLog: { create: async ({ data }: any) => { calls.push(`log:${data.operation}`); } },
    shipmentLabel: { createMany: async () => { calls.push('labels'); } },
    $transaction: async (action: (tx: any) => Promise<void>) => action(prisma),
  };
  const mapper: any = { buildShipment: async () => payload };
  const connector: any = {
    getAccessToken: async () => ({ accessToken: 'test-token' }),
    validate: async () => { calls.push('validate'); return {}; },
    createShipment: async () => { calls.push('create'); return { output: { transactionShipments: [] } }; },
    extractLabels: () => ({ masterTrackingNumber: 'tracking-1', labels: Array.from({ length: boxCount }, (_, index) => ({ trackingNumber: `tracking-${index + 1}`, contentType: 'application/pdf', encodedLabel: 'JVBERg==' })) }),
  };
  const config: any = { status: () => ({ configured: true, environment: 'PRODUCTION' }), assertReady: () => undefined };
  return { service: new FedexValidationService(prisma, mapper, connector, config), calls };
}

test('FedEx 多箱订单跳过单箱专用预校验并创建整票面单', async () => {
  const { service, calls } = fixture(8);
  const stages: string[] = [];
  const result = await service.create('order-1', async (stage) => { stages.push(stage); });
  assert.deepEqual(stages, ['CREATING']);
  assert.equal(result.labelCount, 8);
  assert.equal(calls.includes('validate'), false);
  assert.equal(calls.filter((call) => call === 'create').length, 1);
  assert.equal(calls.includes('labels'), true);
});

test('FedEx 单箱订单仍先预校验再创建面单', async () => {
  const { service, calls } = fixture(1);
  const stages: string[] = [];
  await service.create('order-1', async (stage) => { stages.push(stage); });
  assert.deepEqual(stages, ['VALIDATING', 'CREATING']);
  assert.ok(calls.indexOf('validate') < calls.indexOf('create'));
});

test('FedEx 手动预校验多箱订单时给出明确限制提示', async () => {
  const { service, calls } = fixture(8);
  await assert.rejects(() => service.validate('order-1'), BadRequestException);
  assert.equal(calls.includes('validate'), false);
});
