-- Additive migration. Back up production before running. Historical FedEx rows remain unchanged.
BEGIN;
ALTER TABLE "OrderBox" ADD COLUMN IF NOT EXISTS "carrierTrackingNumber" TEXT;
ALTER TABLE "ShipmentLabel" ADD COLUMN IF NOT EXISTS "boxId" TEXT;
ALTER TABLE "ShipmentLabel" ADD COLUMN IF NOT EXISTS "sourceContent" BYTEA;
ALTER TABLE "ShipmentLabel" ADD COLUMN IF NOT EXISTS "sourceContentType" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentLabel_boxId_key" ON "ShipmentLabel"("boxId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShipmentLabel_boxId_fkey') THEN
    ALTER TABLE "ShipmentLabel" ADD CONSTRAINT "ShipmentLabel_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "OrderBox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
COMMIT;
