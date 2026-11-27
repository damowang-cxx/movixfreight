import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CancellationRefundStatus, FeeStatus, Order, Prisma, WalletLedgerType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BalanceAlertsService } from '../balance-alerts/balance-alerts.service';
import { PrismaService } from '../database/prisma.service';

type RefundOrder = Pick<Order, 'id' | 'orderNo' | 'customerId' | 'currency' | 'prechargedAmount' | 'feeStatus'>;

export async function withCancellationTransaction<T>(prisma: PrismaService, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt === 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034') throw error;
    }
  }
  throw new ConflictException('取消退款事务未能完成');
}

@Injectable()
export class CancellationRefundService {
  constructor(private readonly balanceAlerts: BalanceAlertsService) {}

  assertRefundable(order: RefundOrder) {
    if (order.feeStatus !== FeeStatus.PRECHARGED && order.feeStatus !== FeeStatus.FINAL_WEIGHT_PENDING) {
      throw new ConflictException('订单费用已进入对账或退款流程，请先核查账务后再取消');
    }
  }

  async complete(tx: Prisma.TransactionClient, order: RefundOrder, operatorId?: string) {
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, orderNo: true, customerId: true, currency: true, prechargedAmount: true, feeStatus: true, shipmentStatus: true } });
    if (current.shipmentStatus !== 'GENERATING') throw new ConflictException('订单取消状态已变化，请刷新后重试');
    this.assertRefundable(current);
    const existing = await tx.cancellationRefundCase.findUnique({ where: { orderId: current.id } });
    const ledger = await tx.walletLedger.findFirst({ where: { relatedOrderId: current.id, type: WalletLedgerType.CANCELLATION_REFUND } });
    if (existing || ledger) throw new ConflictException('该订单已有取消退款记录，不能重复退款');
    const wallet = await tx.customerWallet.findUnique({ where: { customerId_currency: { customerId: current.customerId, currency: current.currency } } });
    if (!wallet) throw new NotFoundException('客户对应币种的钱包不存在，取消未完成');
    const balanceAfter = wallet.balance.plus(current.prechargedAmount);
    await tx.customerWallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter, version: { increment: 1 } } });
    await tx.walletLedger.create({ data: {
      ledgerNo: `LED-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`,
      walletId: wallet.id, type: WalletLedgerType.CANCELLATION_REFUND, amount: current.prechargedAmount,
      balanceBefore: wallet.balance, balanceAfter, relatedOrderId: current.id,
      reason: `订单 ${current.orderNo} 取消退款`, operatorId,
    } });
    await tx.cancellationRefundCase.create({ data: {
      orderId: current.id, currency: current.currency, refundAmount: current.prechargedAmount,
      status: CancellationRefundStatus.CONFIRMED, createdById: operatorId, confirmedById: operatorId, confirmedAt: new Date(),
    } });
    await tx.order.update({ where: { id: current.id }, data: { shipmentStatus: 'CANCELLED', feeStatus: FeeStatus.REFUNDED } });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: current.customerId }, select: { customerNo: true, username: true } });
    await this.balanceAlerts.evaluateInTransaction(tx, {
      customerId: current.customerId, customerNo: customer.customerNo, username: customer.username,
      walletId: wallet.id, currency: current.currency, balance: balanceAfter,
    });
    return balanceAfter;
  }
}
