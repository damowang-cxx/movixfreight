-- 渠道燃油附加费：一个尾程渠道的全部供应商连接和服务共用同一费率。
-- CarrierChannel 在数据库中沿用历史表名 Supplier。
ALTER TABLE "Supplier"
  ADD COLUMN IF NOT EXISTS "fuelEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "fuelPercent" DECIMAL(8,4);
