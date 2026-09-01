CREATE TABLE IF NOT EXISTS "CustomerLevel" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerLevel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerLevel_code_key" UNIQUE ("code"),
  CONSTRAINT "CustomerLevel_name_key" UNIQUE ("name")
);

CREATE TABLE IF NOT EXISTS "CustomerGroup" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerGroup_code_key" UNIQUE ("code"),
  CONSTRAINT "CustomerGroup_name_key" UNIQUE ("name")
);

CREATE TABLE IF NOT EXISTS "CustomerLevelAssignment" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "customerLevelId" TEXT NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerLevelAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomerGroupAssignment" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "customerGroupId" TEXT NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerGroupAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProfitVersionChangeLog" (
  "id" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "changedById" TEXT,
  "beforeSnapshot" JSONB NOT NULL,
  "afterSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfitVersionChangeLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OrderPriceRecalculation" (
  "id" TEXT NOT NULL,
  "reconciliationId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "asOfDate" TIMESTAMP(3) NOT NULL,
  "calculatedAmount" DECIMAL(18,2) NOT NULL,
  "chargeableWeightsKg" JSONB NOT NULL,
  "quoteSnapshot" JSONB NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderPriceRecalculation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OrderBox" ADD COLUMN IF NOT EXISTS "finalChargeableWeightKg" DECIMAL(12,3);

CREATE INDEX IF NOT EXISTS "CustomerLevelAssignment_customerId_effectiveFrom_effectiveTo_idx" ON "CustomerLevelAssignment" ("customerId", "effectiveFrom", "effectiveTo");
CREATE INDEX IF NOT EXISTS "CustomerLevelAssignment_customerLevelId_idx" ON "CustomerLevelAssignment" ("customerLevelId");
CREATE INDEX IF NOT EXISTS "CustomerGroupAssignment_customerId_effectiveFrom_effectiveTo_idx" ON "CustomerGroupAssignment" ("customerId", "effectiveFrom", "effectiveTo");
CREATE INDEX IF NOT EXISTS "CustomerGroupAssignment_customerGroupId_idx" ON "CustomerGroupAssignment" ("customerGroupId");
CREATE INDEX IF NOT EXISTS "ProfitVersionChangeLog_versionId_createdAt_idx" ON "ProfitVersionChangeLog" ("versionId", "createdAt");
CREATE INDEX IF NOT EXISTS "OrderPriceRecalculation_reconciliationId_createdAt_idx" ON "OrderPriceRecalculation" ("reconciliationId", "createdAt");
CREATE INDEX IF NOT EXISTS "OrderPriceRecalculation_orderId_createdAt_idx" ON "OrderPriceRecalculation" ("orderId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerLevelAssignment_customerId_fkey') THEN ALTER TABLE "CustomerLevelAssignment" ADD CONSTRAINT "CustomerLevelAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerLevelAssignment_customerLevelId_fkey') THEN ALTER TABLE "CustomerLevelAssignment" ADD CONSTRAINT "CustomerLevelAssignment_customerLevelId_fkey" FOREIGN KEY ("customerLevelId") REFERENCES "CustomerLevel"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerGroupAssignment_customerId_fkey') THEN ALTER TABLE "CustomerGroupAssignment" ADD CONSTRAINT "CustomerGroupAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerGroupAssignment_customerGroupId_fkey') THEN ALTER TABLE "CustomerGroupAssignment" ADD CONSTRAINT "CustomerGroupAssignment_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "CustomerGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProfitVersionChangeLog_versionId_fkey') THEN ALTER TABLE "ProfitVersionChangeLog" ADD CONSTRAINT "ProfitVersionChangeLog_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ServiceProfitVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderPriceRecalculation_reconciliationId_fkey') THEN ALTER TABLE "OrderPriceRecalculation" ADD CONSTRAINT "OrderPriceRecalculation_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "OrderReconciliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderPriceRecalculation_orderId_fkey') THEN ALTER TABLE "OrderPriceRecalculation" ADD CONSTRAINT "OrderPriceRecalculation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
END $$;
