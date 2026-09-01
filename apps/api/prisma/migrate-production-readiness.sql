DO $$ BEGIN
  CREATE TYPE "CancellationRefundStatus" AS ENUM ('PENDING_FINANCE_CONFIRMATION', 'CONFIRMED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ShipmentDispatchJob" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "CancellationRefundCase" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "status" "CancellationRefundStatus" NOT NULL DEFAULT 'PENDING_FINANCE_CONFIRMATION',
  "currency" "Currency" NOT NULL,
  "refundAmount" DECIMAL(18,2) NOT NULL,
  "createdById" TEXT,
  "confirmedById" TEXT,
  "confirmationNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  CONSTRAINT "CancellationRefundCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CancellationRefundCase_orderId_key" UNIQUE ("orderId"),
  CONSTRAINT "CancellationRefundCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CancellationRefundCase_status_createdAt_idx" ON "CancellationRefundCase"("status", "createdAt");
