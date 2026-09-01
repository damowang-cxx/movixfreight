import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActualDataSource, CancellationRefundStatus, CustomerStatus, FeeStatus, MeasurementMethod, Prisma, ReconciliationStatus, SupplierBillImportStatus, SupplierBillMatchStatus, WalletLedgerType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { BalanceAlertsService } from '../balance-alerts/balance-alerts.service';
import { PricingService } from '../pricing/pricing.service';

type ImportedRow = {
  lineNo: number;
  trackingNumber?: string;
  supplierActualWeightKg?: string;
  finalChargeableWeightKg?: string;
  supplierFinalCost?: string;
  currency?: 'EUR' | 'GBP';
  rawData: Record<string, unknown>;
};

type CreateImportInput = {
  supplierId: string;
  channelId?: string;
  originalFilename: string;
  currency: 'EUR' | 'GBP';
  billingPeriodFrom?: string;
  billingPeriodTo?: string;
  rows: ImportedRow[];
};

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService, private readonly balanceAlerts: BalanceAlertsService, private readonly pricing: PricingService) {}

  listImports() {
    return this.prisma.supplierBillImportBatch.findMany({
      include: { supplier: { select: { code: true, name: true } }, channel: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getImport(batchId: string) {
    const batch = await this.prisma.supplierBillImportBatch.findUnique({
      where: { id: batchId },
      include: { supplier: { select: { code: true, name: true } }, channel: { select: { code: true, name: true } }, lines: { include: { order: { select: { id: true, orderNo: true, carrierTrackingNumber: true, feeStatus: true } }, reconciliation: true }, orderBy: { lineNo: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('账单导入批次不存在');
    return batch;
  }

  async createImport(input: CreateImportInput, createdById: string) {
    if (!input.rows.length) throw new BadRequestException('账单中至少需要一条明细');
    if (new Set(input.rows.map((row) => row.lineNo)).size !== input.rows.length) throw new BadRequestException('账单行号不可重复');
    const supplier = await this.prisma.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw new NotFoundException('供应商不存在');
    if (input.channelId) {
      const channel = await this.prisma.supplier.findFirst({ where: { id: input.channelId, carrierId: input.supplierId } });
      if (!channel) throw new BadRequestException('渠道不存在或不属于该供应商');
    }

    const lines = await Promise.all(input.rows.map((row) => this.matchRow(row, input.channelId)));
    const matchedRows = lines.filter((line) => line.matchStatus === SupplierBillMatchStatus.MATCHED).length;
    const unmatchedRows = lines.length - matchedRows;
    return this.prisma.supplierBillImportBatch.create({
      data: {
        supplierId: input.supplierId,
        channelId: input.channelId,
        originalFilename: input.originalFilename,
        currency: input.currency,
        billingPeriodFrom: input.billingPeriodFrom ? new Date(input.billingPeriodFrom) : undefined,
        billingPeriodTo: input.billingPeriodTo ? new Date(input.billingPeriodTo) : undefined,
        status: unmatchedRows ? SupplierBillImportStatus.PARTIALLY_MATCHED : SupplierBillImportStatus.MATCHED,
        totalRows: lines.length,
        matchedRows,
        unmatchedRows,
        createdById,
        lines: { create: lines },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
  }

  async applyImport(batchId: string, createdById: string) {
    const batch = await this.getImport(batchId);
    if (batch.status === SupplierBillImportStatus.APPLIED) throw new ConflictException('该账单批次已应用，不能重复处理');
    const matched = batch.lines.filter((line) => line.matchStatus === SupplierBillMatchStatus.MATCHED && line.orderId);
    if (!matched.length) throw new BadRequestException('没有可应用的已匹配账单明细');
    if (matched.some((line) => line.reconciliation)) throw new ConflictException('存在已进入对账流程的明细，请刷新后处理');

    await this.prisma.$transaction(async (tx) => {
      for (const line of matched) {
        const existing = await tx.orderReconciliation.findUnique({ where: { orderId: line.orderId! } });
        if (existing) throw new ConflictException('订单已存在待确认或已完成的对账记录，不能重复导入');
        await tx.order.update({
          where: { id: line.orderId! },
          data: {
            supplierActualWeightKg: line.supplierActualWeightKg,
            finalChargeableWeightKg: line.finalChargeableWeightKg,
            supplierFinalCost: line.supplierFinalCost,
            actualDataSource: ActualDataSource.BILL_EXCEL_IMPORT,
            feeStatus: FeeStatus.RECONCILIATION_PENDING,
          },
        });
        await tx.orderReconciliation.create({
          data: {
            orderId: line.orderId!,
            sourceLineId: line.id,
            prechargedAmount: (await tx.order.findUniqueOrThrow({ where: { id: line.orderId! }, select: { prechargedAmount: true } })).prechargedAmount,
            currency: batch.currency,
            createdById,
          },
        });
        await tx.supplierBillImportLine.update({ where: { id: line.id }, data: { matchStatus: SupplierBillMatchStatus.APPLIED, matchMessage: '已写入订单实际数据，等待会计确认差额' } });
      }
      await tx.supplierBillImportBatch.update({ where: { id: batchId }, data: { status: SupplierBillImportStatus.APPLIED, appliedAt: new Date() } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return this.getImport(batchId);
  }

  listReconciliations() {
    return this.prisma.orderReconciliation.findMany({
      include: {
        order: {
          include: {
            customer: { select: { customerNo: true, username: true } },
            service: { select: { code: true, name: true, measurementMethod: true } },
            boxes: { select: { id: true, boxNo: true, finalChargeableWeightKg: true }, orderBy: { boxNo: 'asc' } },
          },
        },
        sourceLine: {
          include: {
            batch: {
              select: {
                originalFilename: true,
                supplier: { select: { code: true, name: true } },
              },
            },
          },
        },
        recalculations: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  listCancellationRefunds() {
    return this.prisma.cancellationRefundCase.findMany({ include: { order: { include: { customer: { select: { customerNo: true, username: true, wallets: { select: { id: true, currency: true, balance: true } } } }, service: { select: { code: true, name: true } } } } }, orderBy: { createdAt: 'desc' } });
  }

  async confirmCancellationRefund(caseId: string, input: { approved: boolean; confirmationNote?: string }, confirmedById: string) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.cancellationRefundCase.findUnique({ where: { id: caseId }, include: { order: { include: { customer: { include: { wallets: true } } } } } });
      if (!item) throw new NotFoundException('取消退款待办不存在');
      if (item.status !== CancellationRefundStatus.PENDING_FINANCE_CONFIRMATION) throw new ConflictException('该取消退款待办已处理，不能重复确认');
      if (!input.approved) return tx.cancellationRefundCase.update({ where: { id: caseId }, data: { status: CancellationRefundStatus.REJECTED, confirmedById, confirmationNote: input.confirmationNote, confirmedAt: new Date() } });
      const wallet = item.order.customer.wallets.find((value) => value.currency === item.currency);
      if (!wallet) throw new NotFoundException('客户对应币种的钱包不存在');
      const balanceAfter = wallet.balance.plus(item.refundAmount);
      await tx.customerWallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter, version: { increment: 1 } } });
      await tx.walletLedger.create({ data: { ledgerNo: this.number('LED'), walletId: wallet.id, type: WalletLedgerType.CANCELLATION_REFUND, amount: item.refundAmount, balanceBefore: wallet.balance, balanceAfter, relatedOrderId: item.orderId, reason: `订单 ${item.order.orderNo} 取消退款`, operatorId: confirmedById } });
      await this.balanceAlerts.evaluateInTransaction(tx, { customerId: item.order.customerId, customerNo: item.order.customer.customerNo, username: item.order.customer.username, walletId: wallet.id, currency: item.currency, balance: balanceAfter });
      await tx.order.update({ where: { id: item.orderId }, data: { feeStatus: FeeStatus.REFUNDED } });
      const updated = await tx.cancellationRefundCase.update({ where: { id: caseId }, data: { status: CancellationRefundStatus.CONFIRMED, confirmedById, confirmationNote: input.confirmationNote, confirmedAt: new Date() } });
      return { refund: updated, walletBalance: balanceAfter };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async recalculate(reconciliationId: string, input: { asOfDate?: string; boxes?: Array<{ boxId: string; finalChargeableWeightKg: string }> }, createdById: string) {
    const reconciliation = await this.prisma.orderReconciliation.findUnique({ where: { id: reconciliationId }, include: { order: { include: { service: true, boxes: true } } } });
    if (!reconciliation) throw new NotFoundException('对账记录不存在');
    if (reconciliation.status !== ReconciliationStatus.PENDING_FINANCE_CONFIRMATION) throw new ConflictException('只有待会计确认的订单可以重算');
    const asOfDate = input.asOfDate ? new Date(input.asOfDate) : reconciliation.order.createdAt;
    if (Number.isNaN(asOfDate.valueOf())) throw new BadRequestException('重算计费日期无效');
    let weights: string[];
    if (reconciliation.order.service.measurementMethod === MeasurementMethod.PER_BOX) {
      const supplied = new Map((input.boxes ?? []).map((box) => [box.boxId, box.finalChargeableWeightKg]));
      const allowedBoxIds = new Set(reconciliation.order.boxes.map((box) => box.id));
      if ([...supplied.keys()].some((boxId) => !allowedBoxIds.has(boxId))) throw new BadRequestException('存在不属于该订单的箱号，不能保存最终收费重');
      const missing = reconciliation.order.boxes.filter((box) => !supplied.get(box.id) && !box.finalChargeableWeightKg);
      if (missing.length) throw new BadRequestException(`按箱计价必须填写每箱最终收费重，缺少箱号：${missing.map((box) => box.boxNo).join('、')}`);
      if (input.boxes?.length) await this.prisma.$transaction(input.boxes.map((box) => this.prisma.orderBox.update({ where: { id: box.boxId }, data: { finalChargeableWeightKg: box.finalChargeableWeightKg } })));
      const refreshed = await this.prisma.orderBox.findMany({ where: { orderId: reconciliation.orderId }, orderBy: { boxNo: 'asc' } });
      weights = refreshed.map((box) => box.finalChargeableWeightKg!.toString());
    } else {
      if (!reconciliation.order.finalChargeableWeightKg) throw new BadRequestException('按票计价必须先录入整票最终收费重');
      weights = [reconciliation.order.finalChargeableWeightKg.toString()];
    }
    const quote = await this.pricing.quote(reconciliation.order.customerId, reconciliation.order.serviceId, reconciliation.order.recipientCountryCode, weights, reconciliation.order.recipientPostcode, reconciliation.order.boxes.map((box) => ({ lengthCm: box.lengthCm.toString(), widthCm: box.widthCm.toString(), heightCm: box.heightCm.toString() })), { asOf: asOfDate, useProvidedChargeableWeights: true });
    const record = await this.prisma.orderPriceRecalculation.create({ data: { reconciliationId, orderId: reconciliation.orderId, asOfDate, calculatedAmount: quote.total, chargeableWeightsKg: weights, quoteSnapshot: JSON.parse(JSON.stringify(quote)) as Prisma.InputJsonValue, createdById } });
    return { ...record, quote };
  }

  async confirmReconciliation(reconciliationId: string, input: { finalReceivableAmount: string; confirmationNote?: string }, confirmedById: string) {
    const finalAmount = new Prisma.Decimal(input.finalReceivableAmount);
    return this.prisma.$transaction(async (tx) => {
      const reconciliation = await tx.orderReconciliation.findUnique({
        where: { id: reconciliationId },
        include: { order: { include: { customer: { include: { wallets: true } } } } },
      });
      if (!reconciliation) throw new NotFoundException('对账记录不存在');
      if (reconciliation.status !== ReconciliationStatus.PENDING_FINANCE_CONFIRMATION) throw new ConflictException('该对账记录已处理，不能重复确认');
      if (reconciliation.order.currency !== reconciliation.currency) throw new ConflictException('订单与对账币种不一致，无法确认');
      const wallet = reconciliation.order.customer.wallets.find((item) => item.currency === reconciliation.currency);
      if (!wallet) throw new NotFoundException('客户对应币种的钱包不存在');

      const difference = finalAmount.minus(reconciliation.prechargedAmount);
      const ledgerAmount = difference.greaterThan(0) ? difference.negated() : difference.abs();
      const balanceAfter = wallet.balance.plus(ledgerAmount);
      if (!difference.isZero()) {
        await tx.customerWallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter, version: { increment: 1 } } });
        await tx.walletLedger.create({
          data: {
            ledgerNo: this.number('LED'),
            walletId: wallet.id,
            type: difference.greaterThan(0) ? WalletLedgerType.RECONCILIATION_DEBIT : WalletLedgerType.RECONCILIATION_REFUND,
            amount: ledgerAmount,
            balanceBefore: wallet.balance,
            balanceAfter,
            relatedOrderId: reconciliation.orderId,
            reason: difference.greaterThan(0) ? `订单 ${reconciliation.order.orderNo} 对账补扣` : `订单 ${reconciliation.order.orderNo} 对账退款`,
            operatorId: confirmedById,
          },
        });
        await this.balanceAlerts.evaluateInTransaction(tx, { customerId: reconciliation.order.customerId, customerNo: reconciliation.order.customer.customerNo, username: reconciliation.order.customer.username, walletId: wallet.id, currency: wallet.currency, balance: balanceAfter });
      }
      const balances = reconciliation.order.customer.wallets.map((item) => item.id === wallet.id ? balanceAfter : item.balance);
      if (reconciliation.order.customer.status !== CustomerStatus.FROZEN) {
        await tx.customer.update({ where: { id: reconciliation.order.customerId }, data: { status: balances.some((balance) => balance.lessThan(0)) ? CustomerStatus.ARREARS : CustomerStatus.NORMAL } });
      }
      await tx.order.update({
        where: { id: reconciliation.orderId },
        data: {
          finalReceivableAmount: finalAmount,
          feeStatus: FeeStatus.RECONCILED,
          feeLines: { create: { feeType: 'FINAL_RECEIVABLE', amount: finalAmount, currency: reconciliation.currency, isFinal: true, snapshot: { reconciliationId, confirmationNote: input.confirmationNote ?? null } } },
        },
      });
      const updated = await tx.orderReconciliation.update({
        where: { id: reconciliationId },
        data: { status: ReconciliationStatus.CONFIRMED, finalAmount, differenceAmount: difference, confirmedById, confirmationNote: input.confirmationNote, confirmedAt: new Date() },
      });
      return { reconciliation: updated, differenceAmount: difference, walletBalance: balanceAfter };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async matchRow(row: ImportedRow, channelId?: string): Promise<Prisma.SupplierBillImportLineCreateWithoutBatchInput> {
    const trackingNumber = row.trackingNumber?.trim() || undefined;
    const data = {
      lineNo: row.lineNo,
      trackingNumber,
      supplierActualWeightKg: row.supplierActualWeightKg,
      finalChargeableWeightKg: row.finalChargeableWeightKg,
      supplierFinalCost: row.supplierFinalCost,
      currency: row.currency,
      rawData: row.rawData as Prisma.InputJsonValue,
    };
    if (!trackingNumber) return { ...data, matchStatus: SupplierBillMatchStatus.UNMATCHED, matchMessage: '账单行缺少运单号' };
    const order = await this.prisma.order.findUnique({ where: { carrierTrackingNumber: trackingNumber }, include: { service: true, reconciliation: true } });
    if (!order) return { ...data, matchStatus: SupplierBillMatchStatus.UNMATCHED, matchMessage: '未找到对应系统订单' };
    if (channelId && order.service.supplierId !== channelId) return { ...data, matchStatus: SupplierBillMatchStatus.CHANNEL_MISMATCH, matchMessage: '运单所属供应商与导入供应商不一致', order: { connect: { id: order.id } } };
    if (order.reconciliation) return { ...data, matchStatus: SupplierBillMatchStatus.ALREADY_RECONCILING, matchMessage: '订单已有对账记录', order: { connect: { id: order.id } } };
    return { ...data, matchStatus: SupplierBillMatchStatus.MATCHED, matchMessage: '已匹配订单，待应用', order: { connect: { id: order.id } } };
  }

  private number(prefix: string) {
    return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }
}
