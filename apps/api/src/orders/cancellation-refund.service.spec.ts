import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FeeStatus, Prisma, ShipmentStatus, WalletLedgerType } from '@prisma/client';
import { CancellationRefundService, withCancellationTransaction } from './cancellation-refund.service';

test('管理员取消后同一事务写入余额、退款流水及已退款状态，并阻止重复退款', async () => {
  const order: any = { id: 'order-1', orderNo: 'ORD-1', customerId: 'customer-1', currency: 'EUR', prechargedAmount: new Prisma.Decimal('45.24'), feeStatus: FeeStatus.PRECHARGED, shipmentStatus: ShipmentStatus.GENERATING };
  const wallet: any = { id: 'wallet-1', balance: new Prisma.Decimal('100.00'), version: 0 };
  const ledgers: any[] = [];
  let refundCase: any = null;
  let alertBalance: string | undefined;
  const tx: any = {
    cancellationRefundCase: { findUnique: async () => refundCase, create: async ({ data }: any) => { refundCase = data; return data; } },
    walletLedger: { findFirst: async () => ledgers[0] ?? null, create: async ({ data }: any) => { ledgers.push(data); return data; } },
    customerWallet: { findUnique: async () => wallet, update: async ({ data }: any) => { wallet.balance = data.balance; wallet.version++; return wallet; } },
    customer: { findUniqueOrThrow: async () => ({ customerNo: 'C001', username: 'Test' }) },
    order: { findUniqueOrThrow: async () => order, update: async ({ data }: any) => { Object.assign(order, data); return order; } },
  };
  const service = new CancellationRefundService({ evaluateInTransaction: async (_tx: any, change: any) => { alertBalance = change.balance.toFixed(2); } } as any);
  const balanceAfter = await service.complete(tx, order, 'admin-1');
  assert.equal(balanceAfter.toFixed(2), '145.24');
  assert.equal(wallet.balance.toFixed(2), '145.24');
  assert.equal(wallet.version, 1);
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].type, WalletLedgerType.CANCELLATION_REFUND);
  assert.equal(ledgers[0].amount.toFixed(2), '45.24');
  assert.equal(ledgers[0].operatorId, 'admin-1');
  assert.equal(refundCase.status, 'CONFIRMED');
  assert.equal(order.shipmentStatus, ShipmentStatus.CANCELLED);
  assert.equal(order.feeStatus, FeeStatus.REFUNDED);
  assert.equal(alertBalance, '145.24');
  await assert.rejects(() => service.complete(tx, order, 'admin-1'));
  assert.equal(ledgers.length, 1);
});

test('已完成对账的订单不能进入自动全额退款', () => {
  const service = new CancellationRefundService({} as any);
  assert.throws(() => service.assertRefundable({ feeStatus: FeeStatus.RECONCILED } as any), /核查账务/);
});

test('取消退款事务遇到钱包并发冲突时只重试数据库事务', async () => {
  let attempts = 0;
  const prisma: any = { $transaction: async (action: any) => {
    attempts++;
    if (attempts === 1) throw new Prisma.PrismaClientKnownRequestError('serialization conflict', { code: 'P2034', clientVersion: 'test' });
    return action({});
  } };
  const result = await withCancellationTransaction(prisma, async () => 'refunded');
  assert.equal(result, 'refunded');
  assert.equal(attempts, 2);
});
