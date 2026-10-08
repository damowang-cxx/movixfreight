-- Additive tracking-only migration. Back up production first; this does not
-- change orders, balances, labels, or supplier requests.
BEGIN;
CREATE TABLE IF NOT EXISTS "ShipmentTracking" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "boxId" TEXT,
  "trackingNumber" TEXT NOT NULL,
  "driverCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'LABEL_CREATED',
  "carrierStatusCode" TEXT,
  "carrierDescription" TEXT,
  "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "publicMessage" TEXT,
  "technicalError" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "nextSyncAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3),
  "refreshRequestedAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "ShipmentTrackingEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "trackingId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "carrierStatusCode" TEXT,
  "description" TEXT NOT NULL,
  "city" TEXT,
  "state" TEXT,
  "countryCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentTracking_orderId_trackingNumber_key" ON "ShipmentTracking"("orderId", "trackingNumber");
CREATE INDEX IF NOT EXISTS "ShipmentTracking_nextSyncAt_syncStatus_idx" ON "ShipmentTracking"("nextSyncAt", "syncStatus");
CREATE INDEX IF NOT EXISTS "ShipmentTracking_orderId_idx" ON "ShipmentTracking"("orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentTrackingEvent_trackingId_eventKey_key" ON "ShipmentTrackingEvent"("trackingId", "eventKey");
CREATE INDEX IF NOT EXISTS "ShipmentTrackingEvent_trackingId_occurredAt_idx" ON "ShipmentTrackingEvent"("trackingId", "occurredAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShipmentTracking_orderId_fkey') THEN
    ALTER TABLE "ShipmentTracking" ADD CONSTRAINT "ShipmentTracking_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShipmentTracking_boxId_fkey') THEN
    ALTER TABLE "ShipmentTracking" ADD CONSTRAINT "ShipmentTracking_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "OrderBox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShipmentTrackingEvent_trackingId_fkey') THEN
    ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT "ShipmentTrackingEvent_trackingId_fkey" FOREIGN KEY ("trackingId") REFERENCES "ShipmentTracking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
COMMIT;
