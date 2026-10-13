import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { CustomersService } from './customers.service';

const sharp: typeof import('sharp').default = require('sharp');

async function sampleImage() {
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f3f5f6' } }).png().toBuffer();
  return { buffer, originalname: 'bank-receipt.png', mimetype: 'image/png', size: buffer.length };
}

function harness() {
  const wallet: any = { id: 'wallet-eur', currency: 'EUR', balance: new Prisma.Decimal(100) };
  const ledgerRows: any[] = []; const receipts: any[] = [];
  let failReceipt = false;
  const db: any = {
    customer: { findUnique: async () => ({ id: 'customer-a', customerNo: 'CA', username: '客户A', status: 'NORMAL', wallets: [wallet] }), update: async () => ({}) },
    customerWallet: { update: async ({ data }: any) => { wallet.balance = data.balance; } },
    walletLedger: {
      create: async ({ data }: any) => { const row = { id: 'ledger-1', ...data }; ledgerRows.push(row); return row; },
      findFirst: async ({ where }: any) => { assert.equal(where.wallet.customerId, 'customer-a'); return where.id === 'ledger-1' ? { rechargeReceipt: receipts[0] ?? null } : null; },
      findMany: async ({ where }: any) => { assert.equal(where.wallet.customerId, 'customer-a'); return ledgerRows.map((row) => ({ ...row, wallet: { currency: 'EUR' }, rechargeReceipt: receipts[0] ? { id: 'receipt-1', fileName: receipts[0].fileName, mimeType: receipts[0].mimeType, byteSize: receipts[0].byteSize, sha256: receipts[0].sha256 } : null })); },
    },
    rechargeReceipt: { create: async ({ data }: any) => { if (failReceipt) throw new Error('receipt storage failed'); receipts.push(data); return data; } },
    adminUser: { findMany: async () => [{ id: 'admin-a', displayName: '财务甲', username: 'finance' }] },
    $transaction: async (work: (tx: any) => Promise<any>, options: any) => {
      assert.equal(options.isolationLevel, 'Serializable');
      const previousBalance = wallet.balance; const previousLedgerCount = ledgerRows.length; const previousReceiptCount = receipts.length;
      try { return await work(db); }
      catch (error) { wallet.balance = previousBalance; ledgerRows.length = previousLedgerCount; receipts.length = previousReceiptCount; throw error; }
    },
  };
  const service = new CustomersService(db, { evaluateInTransaction: async () => {} } as any);
  return { service, wallet, ledgerRows, receipts, setFailReceipt: (value: boolean) => { failReceipt = value; } };
}

test('admin credit can succeed without a receipt and remains visible in history', async () => {
  const h = harness();
  const result = await h.service.adjustWallet('customer-a', { currency: 'EUR', amount: '25.00', direction: 'CREDIT', reason: '银行转账到账' } as any, 'admin-a');
  assert.equal(result.type, 'ADMIN_CREDIT');
  assert.equal(h.wallet.balance.toString(), '125');
  assert.equal(h.ledgerRows.length, 1);
  assert.equal(h.receipts.length, 0);
  const history = await h.service.rechargeHistory('customer-a', true);
  assert.equal(history.items[0].receipt, null);
});

test('uploaded receipt must be decodable and saves with balance and ledger', async () => {
  const h = harness();
  const input: any = { currency: 'EUR', amount: '25.00', direction: 'CREDIT', reason: '银行转账到账' };
  await assert.rejects(h.service.adjustWallet('customer-a', input, 'admin-a', { buffer: Buffer.from('not an image'), originalname: 'fake.png', mimetype: 'image/png', size: 12 }), /PNG、JPG 或 WebP/);
  assert.equal(h.ledgerRows.length, 0);
  const image = await sampleImage();
  const result = await h.service.adjustWallet('customer-a', input, 'admin-a', image);
  assert.equal(result.type, 'ADMIN_CREDIT');
  assert.equal(h.wallet.balance.toString(), '125');
  assert.equal(h.ledgerRows.length, 1);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0].ledgerId, result.id);
  assert.equal(h.receipts[0].mimeType, 'image/png');
  assert.equal(h.receipts[0].sha256.length, 64);
  assert.equal((await h.service.rechargeReceipt('customer-a', result.id)).mimeType, 'image/png');
  const history = await h.service.rechargeHistory('customer-a', true);
  assert.equal(history.items[0].ledgerNo, result.ledgerNo);
  assert.equal(history.items[0].operatorName, '财务甲');
});

test('receipt failure rolls back credit; debit cannot masquerade as a receipt upload', async () => {
  const h = harness(); const image = await sampleImage();
  h.setFailReceipt(true);
  await assert.rejects(h.service.adjustWallet('customer-a', { currency: 'EUR', amount: '10', direction: 'CREDIT', reason: '到账' } as any, 'admin-a', image), /receipt storage failed/);
  assert.equal(h.wallet.balance.toString(), '100');
  assert.equal(h.ledgerRows.length, 0);
  await assert.rejects(h.service.adjustWallet('customer-a', { currency: 'EUR', amount: '10', direction: 'DEBIT', reason: '调整' } as any, 'admin-a', image), /不能附加/);
});

test('receipt lookup stays within the authenticated customer scope', async () => {
  const h = harness();
  await assert.rejects(h.service.rechargeReceipt('customer-a', 'other-ledger'), /不存在或无权查看/);
});
