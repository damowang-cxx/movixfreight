import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Currency, CustomerStatus, Prisma, WalletLedgerType } from '@prisma/client';
import { hash } from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { WalletAdjustmentDto } from './dto/wallet-adjustment.dto';
import { BalanceAlertsService } from '../balance-alerts/balance-alerts.service';
const sharp: typeof import('sharp').default = require('sharp');

export type RechargeImage = { buffer: Buffer; originalname: string; mimetype: string; size: number };

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly balanceAlerts: BalanceAlertsService) {}

  async createByAdmin(input: CreateCustomerDto) {
    const [sameCustomerNo, sameUsername] = await Promise.all([
      this.prisma.customer.findUnique({ where: { customerNo: input.customerNo } }),
      this.prisma.customer.findUnique({ where: { username: input.username } }),
    ]);
    if (sameCustomerNo) throw new ConflictException('客户 ID 已存在');
    if (sameUsername) throw new ConflictException('用户名已存在');

    const passwordHash = await hash(input.password, 12);
    return this.prisma.customer.create({
      data: {
        customerNo: input.customerNo,
        username: input.username,
        passwordHash,
        status: CustomerStatus.NORMAL,
        contactName: input.contactName,
        companyName: input.companyName,
        email: input.email,
        phone: input.phone,
        wallets: { create: [{ currency: Currency.EUR }, { currency: Currency.GBP }] },
      },
      select: this.customerSummarySelect,
    });
  }

  async list() {
    return this.prisma.customer.findMany({ orderBy: { createdAt: 'desc' }, select: this.customerSummarySelect });
  }

  customerLevels() { return this.prisma.customerLevel.findMany({ orderBy: [{ enabled: 'desc' }, { name: 'asc' }] }); }
  customerGroups() { return this.prisma.customerGroup.findMany({ orderBy: [{ enabled: 'desc' }, { name: 'asc' }] }); }
  async createCustomerLevel(input: { code: string; name: string }) {
    const code = input.code.trim().toUpperCase(); const name = input.name.trim();
    if (!code || !name) throw new BadRequestException('客户等级编号和名称不能为空');
    try { return await this.prisma.customerLevel.create({ data: { code, name } }); } catch { throw new ConflictException('客户等级编号或名称已存在'); }
  }
  async createCustomerGroup(input: { code: string; name: string }) {
    const code = input.code.trim().toUpperCase(); const name = input.name.trim();
    if (!code || !name) throw new BadRequestException('客户分组编号和名称不能为空');
    try { return await this.prisma.customerGroup.create({ data: { code, name } }); } catch { throw new ConflictException('客户分组编号或名称已存在'); }
  }
  async setCustomerLevelEnabled(id: string, enabled: boolean) { return this.prisma.customerLevel.update({ where: { id }, data: { enabled } }); }
  async setCustomerGroupEnabled(id: string, enabled: boolean) { return this.prisma.customerGroup.update({ where: { id }, data: { enabled } }); }

  async updateClassification(customerId: string, input: { customerLevelId?: string | null; customerGroupId?: string | null; effectiveFrom: string }) {
    const effectiveFrom = new Date(input.effectiveFrom);
    if (Number.isNaN(effectiveFrom.valueOf())) throw new BadRequestException('归属生效日期无效');
    await this.prisma.$transaction(async (tx) => {
      if ('customerLevelId' in input) await this.replaceClassification(tx, 'LEVEL', customerId, input.customerLevelId ?? null, effectiveFrom);
      if ('customerGroupId' in input) await this.replaceClassification(tx, 'GROUP', customerId, input.customerGroupId ?? null, effectiveFrom);
    });
    return this.getById(customerId);
  }

  async classificationAt(customerId: string, at: Date) {
    const [level, group] = await Promise.all([
      this.prisma.customerLevelAssignment.findFirst({ where: { customerId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }, include: { customerLevel: true }, orderBy: { effectiveFrom: 'desc' } }),
      this.prisma.customerGroupAssignment.findFirst({ where: { customerId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }, include: { customerGroup: true }, orderBy: { effectiveFrom: 'desc' } }),
    ]);
    return { level, group };
  }

  async getById(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        ...this.customerSummarySelect,
        levelAssignments: { include: { customerLevel: true }, orderBy: { effectiveFrom: 'desc' } },
        groupAssignments: { include: { customerGroup: true }, orderBy: { effectiveFrom: 'desc' } },
        wallets: { select: { id: true, currency: true, balance: true, updatedAt: true, ledgers: { orderBy: { createdAt: 'desc' }, take: 30 } } },
        apiKey: { select: { keyPrefix: true, createdAt: true, rotatedAt: true } },
      },
    });
    if (!customer) throw new NotFoundException('客户不存在');
    return customer;
  }

  async createApiKey(customerId: string, operatorId: string | undefined) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, apiKey: { select: { id: true } } } });
    if (!customer) throw new NotFoundException('客户不存在');
    if (customer.apiKey) throw new ConflictException('该客户已有 API 密钥；如需更换请使用轮换操作');
    return this.writeApiKey(customerId, operatorId, false);
  }

  async rotateApiKey(customerId: string, operatorId: string | undefined) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new NotFoundException('客户不存在');
    return this.writeApiKey(customerId, operatorId, true);
  }

  async getPortalAccount(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true, customerNo: true, username: true, status: true, contactName: true, companyName: true, email: true, phone: true,
        wallets: { select: { id: true, currency: true, balance: true, updatedAt: true, ledgers: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, ledgerNo: true, type: true, amount: true, balanceBefore: true, balanceAfter: true, reason: true, createdAt: true } } } },
      },
    });
    if (!customer) throw new NotFoundException('客户不存在');
    return customer;
  }

  private async validateRechargeImage(image: RechargeImage | undefined, direction: 'CREDIT' | 'DEBIT') {
    if (direction === 'DEBIT') {
      if (image) throw new BadRequestException('扣减余额不能附加充值水单；请使用入账方向');
      return null;
    }
    if (!image) return null;
    if (!image.buffer?.length || image.buffer.length > 5 * 1024 * 1024 || image.size !== image.buffer.length) throw new BadRequestException('水单图片必须为非空文件，且不超过 5 MB');
    const bytes = image.buffer;
    const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (!detected || image.mimetype !== detected) throw new BadRequestException('水单仅支持真实的 PNG、JPG 或 WebP 图片');
    try {
      const metadata = await sharp(bytes, { limitInputPixels: 20_000_000 }).metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > 20_000_000) throw new Error('图片尺寸无效');
      await sharp(bytes, { limitInputPixels: 20_000_000 }).stats();
    } catch { throw new BadRequestException('水单图片无法完整读取，或像素尺寸超过限制'); }
    const fileName = image.originalname.replace(/[\\/\x00-\x1f\x7f]/g, '').trim().slice(0, 180) || 'recharge-receipt';
    return { fileName, mimeType: detected, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: Uint8Array.from(bytes) };
  }

  async adjustWallet(customerId: string, input: WalletAdjustmentDto, operatorId: string | undefined, image?: RechargeImage) {
    const requestedAmount = new Prisma.Decimal(input.amount);
    if (requestedAmount.lessThanOrEqualTo(0)) throw new BadRequestException('调整金额必须大于 0');
    const receipt = await this.validateRechargeImage(image, input.direction);

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, include: { wallets: true } });
      if (!customer) throw new NotFoundException('客户不存在');

      const wallet = customer.wallets.find((item) => item.currency === input.currency);
      if (!wallet) throw new NotFoundException('客户币种钱包不存在');

      const amount = input.direction === 'CREDIT' ? requestedAmount : requestedAmount.negated();
      const after = wallet.balance.plus(amount);
      if (after.lessThan(0) && !input.allowNegative) {
        throw new BadRequestException('本次人工扣减会导致负余额；如确属会计确认的欠款调整，须以专用对账流程执行');
      }

      await tx.customerWallet.update({
        where: { id: wallet.id },
        data: { balance: after, version: { increment: 1 } },
      });

      const ledger = await tx.walletLedger.create({
        data: {
          ledgerNo: this.createNumber('LED'),
          walletId: wallet.id,
          type: input.direction === 'CREDIT' ? WalletLedgerType.ADMIN_CREDIT : WalletLedgerType.ADMIN_DEBIT,
          amount,
          balanceBefore: wallet.balance,
          balanceAfter: after,
          reason: input.reason,
          operatorId,
        },
      });
      if (receipt) await tx.rechargeReceipt.create({ data: { ledgerId: ledger.id, ...receipt } });

      await this.balanceAlerts.evaluateInTransaction(tx, { customerId: customer.id, customerNo: customer.customerNo, username: customer.username, walletId: wallet.id, currency: wallet.currency, balance: after });

      const allBalances = customer.wallets.map((item) => item.id === wallet.id ? after : item.balance);
      if (customer.status !== CustomerStatus.FROZEN) {
        await tx.customer.update({ where: { id: customerId }, data: { status: allBalances.some((balance) => balance.lessThan(0)) ? CustomerStatus.ARREARS : CustomerStatus.NORMAL } });
      }
      return ledger;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async rechargeHistory(customerId: string, includeOperator: boolean, cursor?: string) {
    if (cursor) {
      const ownedCursor = await this.prisma.walletLedger.findFirst({ where: { id: cursor, wallet: { customerId }, type: WalletLedgerType.ADMIN_CREDIT }, select: { id: true } });
      if (!ownedCursor) throw new BadRequestException('充值历史翻页标识无效');
    }
    const entries = await this.prisma.walletLedger.findMany({
      where: { wallet: { customerId }, type: WalletLedgerType.ADMIN_CREDIT },
      select: { id: true, ledgerNo: true, amount: true, balanceBefore: true, balanceAfter: true, reason: true, operatorId: true, createdAt: true, wallet: { select: { currency: true } }, rechargeReceipt: { select: { id: true, fileName: true, mimeType: true, byteSize: true, sha256: true, createdAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = entries.slice(0, 50);
    const operatorIds = includeOperator ? [...new Set(page.map((entry) => entry.operatorId).filter((id): id is string => Boolean(id)))] : [];
    const operators = operatorIds.length ? await this.prisma.adminUser.findMany({ where: { id: { in: operatorIds } }, select: { id: true, displayName: true, username: true } }) : [];
    const operatorNames = new Map(operators.map((admin) => [admin.id, admin.displayName || admin.username]));
    return {
      items: page.map((entry) => ({ ledgerId: entry.id, ledgerNo: entry.ledgerNo, currency: entry.wallet.currency, amount: entry.amount, balanceBefore: entry.balanceBefore, balanceAfter: entry.balanceAfter, reason: entry.reason, createdAt: entry.createdAt, operatorName: includeOperator ? operatorNames.get(entry.operatorId ?? '') ?? '历史管理员' : undefined, receipt: entry.rechargeReceipt })),
      nextCursor: entries.length > 50 ? page.at(-1)?.id ?? null : null,
    };
  }

  async rechargeReceipt(customerId: string, ledgerId: string) {
    const ledger = await this.prisma.walletLedger.findFirst({ where: { id: ledgerId, wallet: { customerId }, type: WalletLedgerType.ADMIN_CREDIT }, select: { rechargeReceipt: { select: { mimeType: true, content: true } } } });
    if (!ledger?.rechargeReceipt) throw new NotFoundException('充值水单不存在或无权查看');
    return ledger.rechargeReceipt;
  }

  private createNumber(prefix: string) {
    return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  private async writeApiKey(customerId: string, operatorId: string | undefined, rotate: boolean) {
    const keyPrefix = `mvx_${randomBytes(5).toString('hex')}`;
    const apiKey = `${keyPrefix}.${randomBytes(32).toString('base64url')}`;
    const secretHash = await hash(apiKey, 12);
    const record = rotate
      ? await this.prisma.customerApiKey.update({ where: { customerId }, data: { keyPrefix, secretHash, createdById: operatorId, rotatedAt: new Date() }, select: { keyPrefix: true, createdAt: true, rotatedAt: true } })
      : await this.prisma.customerApiKey.create({ data: { customerId, keyPrefix, secretHash, createdById: operatorId }, select: { keyPrefix: true, createdAt: true, rotatedAt: true } });
    return { ...record, apiKey };
  }

  private async replaceClassification(tx: Prisma.TransactionClient, kind: 'LEVEL' | 'GROUP', customerId: string, targetId: string | null, effectiveFrom: Date) {
    if (!await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } })) throw new NotFoundException('客户不存在');
    if (kind === 'LEVEL' && targetId) {
      const target = await tx.customerLevel.findFirst({ where: { id: targetId, enabled: true } }); if (!target) throw new BadRequestException('客户等级不存在或已停用');
    }
    if (kind === 'GROUP' && targetId) {
      const target = await tx.customerGroup.findFirst({ where: { id: targetId, enabled: true } }); if (!target) throw new BadRequestException('客户分组不存在或已停用');
    }
    if (kind === 'LEVEL') {
      const active = await tx.customerLevelAssignment.findFirst({ where: { customerId, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
      if (active && active.effectiveFrom >= effectiveFrom) throw new BadRequestException('归属生效日期必须晚于当前归属开始日期');
      if (active) await tx.customerLevelAssignment.update({ where: { id: active.id }, data: { effectiveTo: new Date(effectiveFrom.getTime() - 1) } });
      if (targetId) await tx.customerLevelAssignment.create({ data: { customerId, customerLevelId: targetId, effectiveFrom } });
    } else {
      const active = await tx.customerGroupAssignment.findFirst({ where: { customerId, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
      if (active && active.effectiveFrom >= effectiveFrom) throw new BadRequestException('归属生效日期必须晚于当前归属开始日期');
      if (active) await tx.customerGroupAssignment.update({ where: { id: active.id }, data: { effectiveTo: new Date(effectiveFrom.getTime() - 1) } });
      if (targetId) await tx.customerGroupAssignment.create({ data: { customerId, customerGroupId: targetId, effectiveFrom } });
    }
  }

  private readonly customerSummarySelect = {
    id: true,
    customerNo: true,
    username: true,
    status: true,
    contactName: true,
    companyName: true,
    email: true,
    phone: true,
    createdAt: true,
    wallets: { select: { currency: true, balance: true } },
    levelAssignments: { where: { effectiveTo: null }, take: 1, include: { customerLevel: { select: { id: true, code: true, name: true } } }, orderBy: { effectiveFrom: 'desc' } },
    groupAssignments: { where: { effectiveTo: null }, take: 1, include: { customerGroup: { select: { id: true, code: true, name: true } } }, orderBy: { effectiveFrom: 'desc' } },
  } satisfies Prisma.CustomerSelect;
}
