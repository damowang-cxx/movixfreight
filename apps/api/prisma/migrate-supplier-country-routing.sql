-- 供应商国家路由：新订单通过供应商和目的国解析内部计价服务与实际承运商 serviceType。
CREATE TABLE IF NOT EXISTS "SupplierCountryRoute" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "routeType" TEXT NOT NULL DEFAULT 'DEFAULT',
  "carrierServiceType" TEXT NOT NULL,
  "customsMode" TEXT NOT NULL DEFAULT 'NONE',
  "fieldConfig" JSONB NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierCountryRoute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierCountryRoute_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "SupplierChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierCountryRoute_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierCountryRoute_supplierId_code_key" ON "SupplierCountryRoute"("supplierId", "code");
CREATE INDEX IF NOT EXISTS "SupplierCountryRoute_supplierId_enabled_idx" ON "SupplierCountryRoute"("supplierId", "enabled");

CREATE TABLE IF NOT EXISTS "SupplierCountryRouteCountry" (
  "routeId" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  CONSTRAINT "SupplierCountryRouteCountry_pkey" PRIMARY KEY ("routeId", "countryCode"),
  CONSTRAINT "SupplierCountryRouteCountry_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "SupplierCountryRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SupplierCountryRouteCountry_countryCode_idx" ON "SupplierCountryRouteCountry"("countryCode");

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "supplierRouteId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "supplierRouteSnapshot" JSONB;
DO $$ BEGIN
  ALTER TABLE "Order" ADD CONSTRAINT "Order_supplierRouteId_fkey" FOREIGN KEY ("supplierRouteId") REFERENCES "SupplierCountryRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "Order_supplierRouteId_idx" ON "Order"("supplierRouteId");

-- 历史订单保持原服务与面单结果，仅写入可审计的 legacy 路由快照。
UPDATE "Order" o
SET "supplierRouteSnapshot" = jsonb_build_object(
  'kind', 'LEGACY_SERVICE',
  'serviceId', s."id",
  'serviceCode', s."code",
  'supplierId', sc."id",
  'supplierCode', sc."code",
  'carrierServiceType', s."carrierServiceType"
)
FROM "Service" s
JOIN "SupplierChannel" sc ON sc."id" = s."channelId"
WHERE o."serviceId" = s."id" AND o."supplierRouteSnapshot" IS NULL;
