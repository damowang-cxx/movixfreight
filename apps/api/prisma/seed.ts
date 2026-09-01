import { AdminRole, PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!username || !password) {
    console.log('未设置 ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD，跳过管理员初始化。');
    return;
  }

  await prisma.adminUser.upsert({
    where: { username },
    update: {},
    create: {
      username,
      passwordHash: await hash(password, 12),
      displayName: '系统管理员',
      roles: { create: [{ role: AdminRole.SUPER_ADMIN }] },
    },
  });
  console.log(`管理员 ${username} 已就绪。`);
}

void main().finally(() => prisma.$disconnect());
