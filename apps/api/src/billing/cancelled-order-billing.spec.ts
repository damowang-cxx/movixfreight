import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';

test('已取消退款的订单不会再匹配、应用或确认供应商账单', async () => {
  let writes = 0;
  const order = { id: 'order-1', shipmentStatus: 'CANCELLED', feeStatus: 'REFUNDED', prechargedAmount: new Prisma.Decimal('45.24') };
  const batch = { id: 'batch-1', status: 'MATCHED', lines: [{ id: 'line-1', orderId: order.id, matchStatus: 'MATCHED', reconciliation: null }] };
  const tx: any = {
    orderReconciliation: { findUnique: async () => null },
    order: { findUniqueOrThrow: async () => order, update: async () => { writes++; } },
    supplierBillImportLine: { update: async () => { writes++; } },
    supplierBillImportBatch: { update: async () => { writes++; } },
  };
  const prisma: any = {
    order: { findUnique: async () => order },
    supplierBillImportBatch: { findUnique: async () => batch },
    $transaction: async (action: any) => action(tx),
  };
  const service = new BillingService(prisma, {} as any, {} as any);
  const matched = await (service as any).matchRow({ lineNo: 1, trackingNumber: 'tracking-1', rawData: {} });
  assert.equal(matched.matchStatus, 'UNMATCHED');
  await assert.rejects(() => service.applyImport('batch-1', 'admin-1'), /已取消或已退款/);
  assert.equal(writes, 0);

  tx.orderReconciliation.findUnique = async () => ({ id: 'reconciliation-1', status: 'PENDING_FINANCE_CONFIRMATION', order, currency: 'EUR' });
  await assert.rejects(() => service.confirmReconciliation('reconciliation-1', { finalReceivableAmount: '45.24' }, 'admin-1'), /已取消或已退款/);
  assert.equal(writes, 0);
});
