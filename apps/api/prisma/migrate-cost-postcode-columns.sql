-- Run before Prisma schema sync. It is idempotent and preserves existing
-- country rates as DEFAULT postcode price columns.
DO $$ BEGIN
  CREATE TYPE "CostPostcodeRuleType" AS ENUM ('DEFAULT', 'EXACT', 'NUMERIC_RANGE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "SupplierCostRate"
  ADD COLUMN IF NOT EXISTS "postcodeRuleType" "CostPostcodeRuleType" NOT NULL DEFAULT 'DEFAULT',
  ADD COLUMN IF NOT EXISTS "postcodeRuleStart" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "postcodeRuleEnd" TEXT,
  ADD COLUMN IF NOT EXISTS "minimumPerShipment" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "registrationFee" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "operationFeePerKg" DECIMAL(18, 4) NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SupplierCostVersion' AND column_name = 'minimumPerBox'
  ) THEN
    EXECUTE 'UPDATE "SupplierCostRate" AS rate
      SET "minimumPerBox" = COALESCE(rate."minimumPerBox", version."minimumPerBox", 0)
      FROM "SupplierCostVersion" AS version
      WHERE rate."versionId" = version.id';
  ELSE
    UPDATE "SupplierCostRate" SET "minimumPerBox" = COALESCE("minimumPerBox", 0);
  END IF;
END $$;

ALTER TABLE "SupplierCostRate"
  ALTER COLUMN "minimumPerBox" SET DEFAULT 0,
  ALTER COLUMN "minimumPerBox" SET NOT NULL;

ALTER TABLE "SupplierCostRate" DROP CONSTRAINT IF EXISTS "SupplierCostRate_versionId_countryCode_key";
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierCostRate_versionId_countryCode_postcodeRule_unique"
  ON "SupplierCostRate" ("versionId", "countryCode", "postcodeRuleType", "postcodeRuleStart");

ALTER TABLE "SupplierCostVersion" DROP COLUMN IF EXISTS "minimumPerBox";
