import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../.env') });
const prisma = new PrismaClient();

async function main() {
  const costs = await prisma.supplierCostVersion.findMany({ where: { supplierConnectionId: null }, select: { id: true, carrierId: true, versionNo: true } });
  const ambiguous: string[] = [];
  for (const cost of costs) {
    const suppliers = await prisma.supplier.findMany({ where: { carrierId: cost.carrierId }, select: { id: true, code: true } });
    if (suppliers.length !== 1) { ambiguous.push(`${cost.versionNo}（候选供应商数：${suppliers.length}）`); continue; }
    await prisma.supplierCostVersion.update({ where: { id: cost.id }, data: { supplierConnectionId: suppliers[0]!.id } });
  }
  if (ambiguous.length) throw new Error(`以下成本表无法安全迁移，请先人工确认供应商连接：${ambiguous.join('；')}`);
  console.log(`供应商连接迁移完成：已检查 ${costs.length} 个旧成本表。`);
}

void main().finally(() => prisma.$disconnect());
