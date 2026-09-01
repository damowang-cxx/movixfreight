ALTER TABLE "ServiceProfitVersion"
  ADD COLUMN IF NOT EXISTS "sourceCostVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultMode" "ProfitMode" NOT NULL DEFAULT 'FIXED_AMOUNT',
  ADD COLUMN IF NOT EXISTS "defaultValue" DECIMAL(18,4) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "ServiceProfitVersion_sourceCostVersionId_idx"
  ON "ServiceProfitVersion" ("sourceCostVersionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceProfitVersion_sourceCostVersionId_fkey') THEN
    ALTER TABLE "ServiceProfitVersion"
      ADD CONSTRAINT "ServiceProfitVersion_sourceCostVersionId_fkey"
      FOREIGN KEY ("sourceCostVersionId") REFERENCES "SupplierCostVersion"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
