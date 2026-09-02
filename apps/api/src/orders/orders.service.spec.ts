import assert from 'node:assert/strict';
import test from 'node:test';
import { ShipmentDispatchJobStatus, ShipmentStatus } from '@prisma/client';
import { OrdersService } from './orders.service';

function service() {
  return new OrdersService({} as any, {} as any, {} as any, {} as any);
}

test('保留客户箱号，并为缺失箱号生成订单号前缀且避免冲突', () => {
  const normalized = (service() as any).normalizeBoxNumbers([
    { boxNo: 'CUSTOM-01', weightKg: '1', lengthCm: '1', widthCm: '1', heightCm: '1', items: [] },
    { boxNo: 'ORD-TEST-001', weightKg: '1', lengthCm: '1', widthCm: '1', heightCm: '1', items: [] },
    { boxNo: '', weightKg: '1', lengthCm: '1', widthCm: '1', heightCm: '1', items: [] },
    { weightKg: '1', lengthCm: '1', widthCm: '1', heightCm: '1', items: [] },
  ], 'ORD-TEST');

  assert.deepEqual(normalized.map((box: { boxNo: string }) => box.boxNo), ['CUSTOM-01', 'ORD-TEST-001', 'ORD-TEST-002', 'ORD-TEST-003']);
});

test('超过十分钟未领取的面单任务显示为待核查，并仅向管理员暴露技术信息', () => {
  const order = { shipmentStatus: ShipmentStatus.SUBMITTED, labels: [], dispatchJob: { status: ShipmentDispatchJobStatus.PENDING, stage: 'QUEUED', queuedAt: new Date(Date.now() - 11 * 60_000), updatedAt: new Date(), errorMessage: 'Redis connection refused' } };
  const admin = service().dispatchSummary(order, true);
  const customer = service().dispatchSummary(order, false);
  assert.equal(admin.status, 'STALLED');
  assert.equal(admin.reasonCode, 'WORKER_NOT_CLAIMED');
  assert.equal(admin.technicalDetail, 'Redis connection refused');
  assert.equal(customer.status, 'STALLED');
  assert.equal('technicalDetail' in customer, false);
});

test('供应商未接入自动打单时显示已阻止而非伪造面单状态', () => {
  const summary = service().dispatchSummary({ shipmentStatus: ShipmentStatus.SUBMITTED, labels: [], dispatchJob: { status: ShipmentDispatchJobStatus.BLOCKED, stage: 'UNSUPPORTED', reasonCode: 'DRIVER_NOT_SUPPORTED', publicMessage: '当前供应商连接暂不支持自动生成面单', updatedAt: new Date() } }, false);
  assert.equal(summary.status, 'BLOCKED');
  assert.equal(summary.message, '当前供应商连接暂不支持自动生成面单');
  assert.equal(summary.retryAllowed, false);
});
