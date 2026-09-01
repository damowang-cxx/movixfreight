-- 按尾程渠道维护燃油附加费的生效区间；CarrierChannel 继续映射历史表 Supplier。
CREATE TABLE IF NOT EXISTS "CarrierFuelSurcharge" (
  "id" TEXT NOT NULL,
  "carrierId" TEXT NOT NULL,
  "percent" DECIMAL(8,4) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CarrierFuelSurcharge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CarrierFuelSurcharge_carrierId_effectiveFrom_effectiveTo_idx"
  ON "CarrierFuelSurcharge" ("carrierId", "effectiveFrom", "effectiveTo");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CarrierFuelSurcharge_carrierId_fkey') THEN
    ALTER TABLE "CarrierFuelSurcharge"
      ADD CONSTRAINT "CarrierFuelSurcharge_carrierId_fkey"
      FOREIGN KEY ("carrierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
