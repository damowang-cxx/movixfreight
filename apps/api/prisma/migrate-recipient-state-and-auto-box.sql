-- Run before Prisma schema sync. Safe for existing production databases.
-- Historical orders retain a NULL recipientState value.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "recipientState" TEXT;
