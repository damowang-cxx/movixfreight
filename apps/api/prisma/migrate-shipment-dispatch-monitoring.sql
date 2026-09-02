-- 自动面单任务状态、失败原因与历史 FedEx 待处理订单回填。
-- 执行前请先完成 Prisma Client 生成；此脚本可重复执行。

DO $$ BEGIN
  ALTER TYPE "ShipmentDispatchJobStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ShipmentDispatchJob" ADD COLUMN IF NOT EXISTS "stage" TEXT;
ALTER TABLE "ShipmentDispatchJob" ADD COLUMN IF NOT EXISTS "reasonCode" TEXT;
ALTER TABLE "ShipmentDispatchJob" ADD COLUMN IF NOT EXISTS "publicMessage" TEXT;
ALTER TABLE "ShipmentDispatchJob" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "ShipmentDispatchJob"
SET "stage" = COALESCE("stage", CASE
  WHEN "status" = 'PENDING' THEN 'QUEUED'
  WHEN "status" = 'PROCESSING' THEN 'VALIDATING'
  WHEN "status" = 'COMPLETED' THEN 'READY'
  ELSE NULL
END),
"publicMessage" = COALESCE("publicMessage", CASE
  WHEN "status" = 'PENDING' THEN '订单已受理，正在等待面单生成'
  WHEN "status" = 'PROCESSING' THEN '正在校验并生成面单'
  WHEN "status" = 'COMPLETED' THEN '面单已生成'
  WHEN "status" = 'FAILED' THEN '面单生成失败，请查看失败原因'
  WHEN "status" = 'UNKNOWN' THEN '面单生成结果未知，请联系客服核查'
  ELSE NULL
END);

-- 用户已确认：将历史已下单、尚未生成面单的 FedEx 订单补入自动任务队列。
INSERT INTO "ShipmentDispatchJob" (
  "id", "orderId", "status", "stage", "reasonCode", "publicMessage", "attempts", "queuedAt", "updatedAt"
)
SELECT
  'dispatch-' || md5(o."id"), o."id", 'PENDING', 'QUEUED', 'HISTORICAL_REQUEUED',
  '历史订单已纳入自动面单生成队列', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Order" o
JOIN "Service" s ON s."id" = o."serviceId"
JOIN "SupplierChannel" sc ON sc."id" = s."channelId"
LEFT JOIN "ShipmentDispatchJob" j ON j."orderId" = o."id"
WHERE o."shipmentStatus" = 'SUBMITTED'
  AND sc."driverCode" = 'FEDEX_RELAY'
  AND o."carrierTrackingNumber" IS NULL
  AND j."id" IS NULL;
