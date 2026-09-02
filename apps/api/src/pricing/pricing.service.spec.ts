import assert from 'node:assert/strict';
import test from 'node:test';
import { CostPostcodeRuleType } from '@prisma/client';
import { PricingService } from './pricing.service';

const countries = [
  { code: 'FR', chineseName: '法国', enabled: true },
  { code: 'NL', chineseName: '荷兰', enabled: true },
];

function service() {
  return new PricingService({
    country: {
      createMany: async () => ({ count: 0 }),
      findMany: async () => countries,
      findFirst: async ({ where }: any) => countries.find((country) => country.enabled && where.OR.some((condition: any) => condition.code === country.code || condition.chineseName === country.chineseName)) ?? null,
    },
  } as any);
}

test('目的国家可用中文名或 ISO 两位代码映射，停用国家会被拒绝', async () => {
  const pricing = service();
  assert.equal(await pricing.resolveDestinationCountry('荷兰'), 'NL');
  assert.equal(await pricing.resolveDestinationCountry('fr'), 'FR');
  await assert.rejects(() => pricing.resolveDestinationCountry('不存在的国家'), /不存在或已停用/);
});

const table = { countries: countries.map((country) => ({ countryCode: country.code, country })) } as any;

test('成本模板允许同国多个邮编价格列并解析国家级费用', async () => {
  const parsed = await (service() as any).parseGrid(table, [
    '重量段\t计价单位\t法国\t法国\t荷兰',
    '0+\t按票\t5.20\t5.50\t4.54',
    '71.01+\t每KG\t0.31\t0.35\t0.19',
    '邮编开头\t\t\t75000\t',
    '最低票运费\t\t0\t1.00\t0',
    '最低箱运费\t\t4.24\t4.50\t4.28',
    '挂号费\t\t0.20/票\t0.30/票\t0.00/票',
    '操作费\t\t0.10/KG\t0.20/KG\t0.00/KG',
  ].join('\n'));

  assert.equal(parsed.rules[0].minKg, '0');
  assert.equal(parsed.rules[0].maxKg, '1');
  assert.deepEqual(parsed.columns.map((column: any) => [column.countryCode, column.postcodeRuleType, column.postcodeRuleStart]), [
    ['FR', CostPostcodeRuleType.DEFAULT, ''],
    ['FR', CostPostcodeRuleType.EXACT, '75000'],
    ['NL', CostPostcodeRuleType.DEFAULT, ''],
  ]);
  assert.equal(parsed.columns[1].minimumPerShipment, '1.00');
  assert.equal(parsed.columns[1].registrationFee, '0.30');
  assert.equal(parsed.columns[1].operationFeePerKg, '0.2000');
});

test('成本模板拒绝重叠的同国数字邮编区间', async () => {
  await assert.rejects(() => (service() as any).parseGrid(table, [
    '重量段\t计价单位\t法国\t法国\t荷兰',
    '0-1\t按票\t5.20\t5.50\t4.54',
    '71.01+\t每KG\t0.31\t0.35\t0.19',
    '邮编开头\t\t2000-2999\t2500-3000\t',
    '最低票运费\t\t0\t0\t0',
    '最低箱运费\t\t4\t4\t4',
    '挂号费\t\t0\t0\t0',
    '操作费\t\t0\t0\t0',
  ].join('\n')), /重叠或重复/);
});
