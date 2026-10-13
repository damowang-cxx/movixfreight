-- Additive migration: link one immutable recharge image to an ADMIN_CREDIT ledger.
-- Back up production before applying. Existing wallet balances and ledger rows are unchanged.
BEGIN;
CREATE TABLE IF NOT EXISTS "RechargeReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ledgerId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "RechargeReceipt_ledgerId_key" ON "RechargeReceipt"("ledgerId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RechargeReceipt_ledgerId_fkey') THEN
    ALTER TABLE "RechargeReceipt" ADD CONSTRAINT "RechargeReceipt_ledgerId_fkey"
      FOREIGN KEY ("ledgerId") REFERENCES "WalletLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
COMMIT;
