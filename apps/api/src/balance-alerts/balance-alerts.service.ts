import { BadRequestException, Injectable } from '@nestjs/common';
import { BalanceAlertAudience, Currency, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

type WalletBalanceChange = { customerId: string; customerNo: string; username: string; walletId: string; currency: Currency; balance: Prisma.Decimal };

@Injectable()
export class BalanceAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async listSettings() {
    const settings = await this.prisma.balanceAlertSetting.findMany({ orderBy: { currency: 'asc' } });
    return (Object.values(Currency) as Currency[]).map((currency) => ({ currency, threshold: settings.find((item) => item.currency === currency)?.threshold ?? new Prisma.Decimal(0), configured: settings.some((item) => item.currency === currency) }));
  }

  async saveSettings(input: { eurThreshold: string; gbpThreshold: string }, updatedById: string) {
    const entries: [Currency, string][] = [[Currency.EUR, input.eurThreshold], [Currency.GBP, input.gbpThreshold]];
    for (const [, value] of entries) if (!/^\d+(\.\d{1,2})?$/.test(value) || new Prisma.Decimal(value).lessThan(0)) throw new BadRequestException('预警阈值必须是大于或等于 0 的两位小数金额');
    return this.prisma.$transaction(entries.map(([currency, value]) => this.prisma.balanceAlertSetting.upsert({ where: { currency }, create: { currency, threshold: value, updatedById }, update: { threshold: value, updatedById } })));
  }

  listNotifications() {
    return this.prisma.balanceAlertNotification.findMany({ include: { customer: { select: { customerNo: true, username: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  listCustomerNotifications(customerId: string) {
    return this.prisma.balanceAlertNotification.findMany({ where: { customerId, audience: BalanceAlertAudience.CUSTOMER }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async markCustomerNotificationRead(customerId: string, notificationId: string) {
    const notification = await this.prisma.balanceAlertNotification.findFirst({ where: { id: notificationId, customerId, audience: BalanceAlertAudience.CUSTOMER } });
    if (!notification) throw new BadRequestException('消息不存在或无权操作');
    if (notification.readAt) return notification;
    return this.prisma.balanceAlertNotification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
  }

  async evaluateInTransaction(tx: Prisma.TransactionClient, change: WalletBalanceChange) {
    const setting = await tx.balanceAlertSetting.findUnique({ where: { currency: change.currency } });
    if (!setting) return;
    const state = await tx.balanceAlertState.findUnique({ where: { walletId: change.walletId } });
    const isLow = change.balance.lessThanOrEqualTo(setting.threshold);
    if (isLow) {
      await tx.balanceAlertState.upsert({ where: { walletId: change.walletId }, create: { walletId: change.walletId, customerId: change.customerId, currency: change.currency, threshold: setting.threshold, balance: change.balance, active: true }, update: { threshold: setting.threshold, balance: change.balance, active: true } });
      if (!state?.active) {
        const content = `客户 ${change.customerNo}（${change.username}）的 ${change.currency} 余额为 ${change.balance.toFixed(2)}，低于或等于预警阈值 ${setting.threshold.toFixed(2)}。`;
        await tx.balanceAlertNotification.createMany({ data: [{ audience: BalanceAlertAudience.ADMIN, walletId: change.walletId, currency: change.currency, title: '客户余额预警', content }, { audience: BalanceAlertAudience.CUSTOMER, customerId: change.customerId, walletId: change.walletId, currency: change.currency, title: '账户余额不足提醒', content: `您的 ${change.currency} 账户余额为 ${change.balance.toFixed(2)}，请联系管理员充值或核对账单。` }] });
      }
      return;
    }
    if (state?.active) await tx.balanceAlertState.update({ where: { walletId: change.walletId }, data: { active: false, threshold: setting.threshold, balance: change.balance } });
  }
}
