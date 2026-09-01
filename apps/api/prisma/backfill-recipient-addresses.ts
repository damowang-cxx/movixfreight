import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Prisma's typed update cannot copy one column into another. Keep this small,
  // reviewable SQL here rather than silently treating old records differently.
  const updated = await prisma.$executeRaw`UPDATE "Order" SET "recipientAddressRaw" = "recipientAddressLine1" WHERE "recipientAddressRaw" IS NULL AND "recipientAddressLine1" IS NOT NULL`;
  console.log(`已回填 ${updated} 条历史订单的原始收件地址`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
