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
