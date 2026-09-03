import { ActualDataSource } from '@prisma/client';

export type ConnectorBusinessField = {
  key: string;
  label: string;
  type: 'SELECT' | 'MULTI_SELECT' | 'TEXT' | 'BOOLEAN';
  required?: boolean;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
};

export type ConnectorDriverDefinition = {
  code: string;
  name: string;
  carrierCodes: string[];
  description: string;
  businessFields: ConnectorBusinessField[];
  serviceModeField?: string;
};

/**
 * FedEx Direct is a transparent FedEx proxy.  These are deliberately a
 * closed set instead of editable serviceType strings: a typo otherwise only
 * surfaces after a customer has already been precharged.
 */
export const fedexRoutePresets = {
  NL_DOMESTIC: {
    carrierServiceType: 'FEDEX_PRIORITY',
    customsMode: 'NONE',
    label: '荷兰本土 FedEx Priority',
    description: '荷兰境内线路。不下发跨境清关货品。',
    packageMaxWeightKg: undefined,
  },
  PAN_EUROPE: {
    carrierServiceType: 'FEDEX_REGIONAL_ECONOMY',
    customsMode: 'COMMODITIES',
    label: '泛欧 FedEx Regional Economy',
    description: '欧洲跨境经济型线路。每箱最多 68 kg；必须申报货品净重、原产国、HS 编码、数量、单价和币种；税费由发件人支付。',
    packageMaxWeightKg: 68,
  },
} as const;

export type FedexRouteType = keyof typeof fedexRoutePresets;
export const fedexRoutePreset = (routeType: string) => fedexRoutePresets[routeType as FedexRouteType];

export const shipmentOptionDefinitions = [
  { code: 'taxWith', label: '交税方式', type: 'SELECT', options: [{ value: 0, label: '不选择' }, { value: 1, label: '不包税' }, { value: 2, label: '包税' }, { value: 3, label: '自主税号' }, { value: 4, label: '自税递延' }] },
  { code: 'deliveryWith', label: '交货条款', type: 'SELECT', options: [{ value: '', label: '不选择' }, { value: 'ddu', label: 'DDU' }, { value: 'ddp', label: 'DDP' }] },
  { code: 'exportWith', label: '报关方式', type: 'SELECT', options: [{ value: 0, label: '不选择' }, { value: 1, label: '买单报关' }, { value: 2, label: '报关退税' }, { value: 3, label: '普通报关' }, { value: 4, label: '合并报关' }, { value: 5, label: '不报关' }, { value: 6, label: '委托报关' }, { value: 7, label: '单独报关' }] },
  { code: 'importWith', label: '清关方式', type: 'SELECT', options: [{ value: 0, label: '不选择' }, { value: 1, label: '一般贸易清关' }, { value: 2, label: '快件清关' }] },
  { code: 'shipmentAttrs', label: '物品属性', type: 'MULTI_SELECT', options: [{ value: 'elec', label: '带电' }, { value: 'magnetic', label: '带磁' }, { value: 'danger', label: '危险品' }, { value: 'liquid', label: '液体' }, { value: 'powder', label: '粉末' }, { value: 'paste', label: '膏体' }, { value: 'sensitive_goods', label: '敏感货' }, { value: 'wood', label: '木制品' }, { value: 'textile', label: '纺织品' }] },
] as const;

const knownShipmentOptionCodes = new Set(shipmentOptionDefinitions.map((item) => item.code));

/** 路由字段只能由驱动的白名单开启，不能把管理端 JSON 原样转发给供应商。 */
export function normalizeRouteFieldConfig(value: Record<string, unknown> | undefined) {
  const requested = Array.isArray(value?.shipmentOptions) ? value!.shipmentOptions.filter((item): item is string => typeof item === 'string') : [];
  const shipmentOptions = [...new Set(requested.filter((item) => knownShipmentOptionCodes.has(item as typeof shipmentOptionDefinitions[number]['code'])))];
  if (requested.length !== shipmentOptions.length) throw new Error('路由字段包含未支持的选项');
  return { shipmentOptions };
}

export function routeFieldSchema(driverCode: string, customsMode: string, fieldConfig: Record<string, unknown> | undefined, routeType?: string) {
  const config = normalizeRouteFieldConfig(fieldConfig);
  const options = shipmentOptionDefinitions.filter((item) => config.shipmentOptions.includes(item.code));
  const commodityRequired = driverCode === 'FEDEX_RELAY' && customsMode === 'COMMODITIES';
  const preset = driverCode === 'FEDEX_RELAY' ? fedexRoutePreset(routeType ?? '') : undefined;
  return {
    shipmentOptions: options,
    customsMode,
    declarationRequired: commodityRequired ? ['englishName', 'itemWeightKg', 'originCountryCode', 'harmonizedCode', 'quantity', 'unitDeclaredValue', 'declaredValueCurrency'] : [],
    carrierRules: preset ? {
      serviceTypeLocked: preset.carrierServiceType,
      packageMaxWeightKg: preset.packageMaxWeightKg ?? null,
      dutiesPayment: customsMode === 'COMMODITIES' ? 'SENDER' : null,
      documentContent: customsMode === 'COMMODITIES' ? 'NON_DOCUMENTS' : null,
      shipmentPurpose: customsMode === 'COMMODITIES' ? 'SOLD' : null,
      // 这些值是当前 FedEx Relay 映射中已经确认并实际下发的固定值。
      // 不是让下单人填写的通用业务枚举，避免把未确认的 DDU/DDP、
      // 报关/清关方式等字段静默丢弃或错误映射到 FedEx。
      fixedFields: customsMode === 'COMMODITIES' ? [
        { code: 'dutiesPayment', label: '税费付款方', value: 'SENDER', displayValue: '发件人支付（固定）' },
        { code: 'documentContent', label: '货物类型', value: 'NON_DOCUMENTS', displayValue: '非文件商业货物（固定）' },
        { code: 'shipmentPurpose', label: '商业发票用途', value: 'SOLD', displayValue: '销售（固定）' },
      ] : [],
      description: preset.description,
    } : undefined,
  };
}

export const connectorDrivers: ConnectorDriverDefinition[] = [
  {
    code: 'FEDEX_RELAY',
    name: 'FedEx Ship-API Direct 中转接口',
    carrierCodes: ['FEDEX'],
    description: '支持 OAuth、Validate、Create、Cancel，以及由供应商面单模板指定的标准 PDF/PNG/ZPLII/EPL2 标签规格。连接凭据由本地配置文件维护。',
    businessFields: [
      { key: 'shipmentModeHandling', label: '件数模式', type: 'SELECT', defaultValue: 'SERVICE_SELECT', options: [{ value: 'SERVICE_SELECT', label: '由服务选择' }, { value: 'NOT_APPLICABLE', label: '接口不区分' }] },
      { key: 'allowedServiceModes', label: '服务可选件数模式', type: 'MULTI_SELECT', defaultValue: ['SINGLE_ONLY', 'MULTI_PIECE'], options: [{ value: 'SINGLE_ONLY', label: '仅一件' }, { value: 'MULTI_PIECE', label: '支持多件' }] },
      { key: 'actualDataSource', label: '实际数据来源', type: 'SELECT', defaultValue: ActualDataSource.BILL_EXCEL_IMPORT, options: [{ value: ActualDataSource.API_CALLBACK, label: '接口回传' }, { value: ActualDataSource.QUERY_API, label: '查单接口' }, { value: ActualDataSource.BILL_EXCEL_IMPORT, label: '供应商账单导入' }] },
    ],
    serviceModeField: 'allowedServiceModes',
  },
];

export function getConnectorDriver(code: string) { return connectorDrivers.find((driver) => driver.code === code); }

export function normalizeBusinessConfig(driver: ConnectorDriverDefinition, value: Record<string, unknown> | undefined) {
  const result: Record<string, unknown> = {};
  for (const field of driver.businessFields) {
    const input = value?.[field.key] ?? field.defaultValue;
    if (field.required && (input === undefined || input === null || input === '')) throw new Error(`缺少业务参数：${field.label}`);
    if (input !== undefined) result[field.key] = input;
  }
  return result;
}
