import assert from 'node:assert/strict';
import test from 'node:test';
import { PriceVersionStatus, ProfitMode, ProfitScope } from '@prisma/client';
import { PricingService } from './pricing.service';

function version(versionNo: string, scope: ProfitScope, scopeTargetId: string | null, countries: string[], defaultValue = '0.50') {
  return { id: versionNo, versionNo, scope, scopeTargetId, status: PriceVersionStatus.ACTIVE, defaultMode: ProfitMode.FIXED_AMOUNT, defaultValue: { toString: () => defaultValue }, rows: countries.map((countryCode) => ({ countryCode, mode: ProfitMode.FIXED_AMOUNT, value: { toString: () => '1.00' } })) };
}

function pricing(versions: ReturnType<typeof version>[]) {
  return new PricingService({
    customerLevelAssignment: { findFirst: async () => ({ customerLevelId: 'level-vip' }) },
    customerGroupAssignment: { findFirst: async () => ({ customerGroupId: 'group-key' }) },
    serviceProfitVersion: { findMany: async ({ where }: any) => versions.filter((item) => item.scope === where.scope && item.scopeTargetId === where.scopeTargetId) },
  } as any);
}

test('利润报价按指定客户、分组、等级、默认报价顺序匹配', async () => {
  const service = pricing([
    version('DEFAULT', ProfitScope.DEFAULT, null, ['NL']),
    version('LEVEL', ProfitScope.CUSTOMER_LEVEL, 'level-vip', ['NL']),
    version('GROUP', ProfitScope.CUSTOMER_GROUP, 'group-key', ['NL']),
    version('SPECIFIC', ProfitScope.SPECIFIC_CUSTOMER, 'customer-1', ['NL']),
  ]);
  const result = await (service as any).resolveProfitVersion('customer-1', 'service-1', 'NL', new Date(), 'SVC');
  assert.equal(result.version.versionNo, 'SPECIFIC');
});

test('命中较高范围但未设置国家例外时，使用该利润版本的默认利润值', async () => {
  const service = pricing([
    version('DEFAULT', ProfitScope.DEFAULT, null, ['NL']),
    version('GROUP-FR-ONLY', ProfitScope.CUSTOMER_GROUP, 'group-key', ['FR']),
  ]);
  const result = await (service as any).resolveProfitVersion('customer-1', 'service-1', 'NL', new Date(), 'SVC');
  assert.equal(result.version.versionNo, 'GROUP-FR-ONLY');
  assert.equal(result.row.mode, ProfitMode.FIXED_AMOUNT);
  assert.equal(result.row.value.toString(), '0.50');
});
