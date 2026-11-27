import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cancelOrdersSequentially, type BatchCancelItem } from '../src/order-batch';

test('批量取消逐票执行，失败不会阻断后续订单，结果保留对应单号和原因', async () => {
  const selected: BatchCancelItem[] = ['ORD-1', 'ORD-2', 'ORD-3'].map((orderNo) => ({ id: orderNo, orderNo, status: 'PENDING' }));
  const calls: string[] = [];
  const snapshots: BatchCancelItem[][] = [];
  const results = await cancelOrdersSequentially(selected, async (item) => {
    calls.push(item.orderNo);
    if (item.orderNo === 'ORD-2') throw new Error('承运商拒绝取消');
  }, (items) => snapshots.push(items));
  assert.deepEqual(calls, ['ORD-1', 'ORD-2', 'ORD-3']);
  assert.deepEqual(results.map((item) => item.status), ['SUCCESS', 'FAILED', 'SUCCESS']);
  assert.equal(results[1]?.error, '承运商拒绝取消');
  assert.deepEqual(selected.map((item) => item.status), ['PENDING', 'PENDING', 'PENDING']);
  assert.ok(snapshots.some((items) => items[1]?.status === 'RUNNING'));
});
