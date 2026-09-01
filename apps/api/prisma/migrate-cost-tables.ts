import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const countries = [['AT', '奥地利'], ['BE', '比利时'], ['BG', '保加利亚'], ['CH', '瑞士'], ['CZ', '捷克'], ['DE', '德国'], ['DK', '丹麦'], ['EE', '爱沙尼亚'], ['ES', '西班牙'], ['FI', '芬兰'], ['FR', '法国'], ['GB', '英国'], ['GR', '希腊'], ['HR', '克罗地亚'], ['HU', '匈牙利'], ['IE', '爱尔兰'], ['IT', '意大利'], ['LT', '立陶宛'], ['LU', '卢森堡'], ['LV', '拉脱维亚'], ['NL', '荷兰'], ['NO', '挪威'], ['PL', '波兰'], ['PT', '葡萄牙'], ['RO', '罗马尼亚'], ['SE', '瑞典'], ['SI', '斯洛文尼亚'], ['SK', '斯洛伐克']] as const;

async function main() {
  await prisma.country.createMany({ data: countries.map(([code, chineseName]) => ({ code, chineseName })), skipDuplicates: true });
  const legacy = await prisma.supplierCostVersion.findMany({ where: { countries: { none: {} }, rows: { some: {} } }, include: { rows: { include: { tiers: true } } } });
  const report: string[] = [];
  for (const table of legacy) {
    const feeValues = [...new Set(table.rows.map((row) => row.minimumPerBox?.toString() ?? '0'))];
    const perKgRows = table.rows.filter((row) => row.perKgAboveKg || row.perKgRate);
    const invalidPerKg = perKgRows.some((row) => !row.perKgAboveKg || !row.perKgRate) || (perKgRows.length > 0 && perKgRows.length !== table.rows.length);
    const tiers = table.rows.flatMap((row) => row.tiers);
    if (feeValues.length !== 1 || invalidPerKg || !tiers.length) { report.push(`${table.versionNo}: ${invalidPerKg ? '每公斤字段不完整或各国家结构不一致' : feeValues.length !== 1 ? '国家最低箱收费不一致' : '缺少重量价格'}`); continue; }
    const known = await prisma.country.findMany({ where: { code: { in: table.rows.map((row) => row.countryCode) } } });
    if (known.length !== table.rows.length) { report.push(`${table.versionNo}: 存在未映射国家代码`); continue; }
    const minWeight = tiers.reduce((min, tier) => Math.min(min, Number(tier.minKg)), Number.POSITIVE_INFINITY); const maxWeight = perKgRows.length ? null : tiers.reduce((max, tier) => Math.max(max, Number(tier.maxKg)), 0);
    await prisma.supplierCostVersion.update({ where: { id: table.id }, data: { minWeightKg: minWeight, maxWeightKg: maxWeight, minBoxes: 1, maxBoxes: null, minimumPerBox: feeValues[0]!, countries: { create: known.map((country) => ({ countryCode: country.code })) }, rows: { update: perKgRows.map((row) => ({ where: { id: row.id }, data: { tiers: { create: { minKg: Number(row.perKgAboveKg) + 0.001, maxKg: '999999.999', fixedAmount: row.perKgRate!, billingUnit: 'PER_KG' } } } })) } } });
  }
  if (report.length) throw new Error(`成本表迁移预检失败，未猜测处理：\n${report.join('\n')}`);
  console.log(`成本表迁移完成：已迁移 ${legacy.length} 张旧成本表。`);
}

main().finally(() => prisma.$disconnect());
