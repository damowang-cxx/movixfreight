import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

type Address = { name: string; company: string; phone: string; streetLines: string[]; city: string; postalCode: string; countryCode: string };
type FedexConnection = { enabled?: boolean; environment?: 'sandbox' | 'production'; baseUrl?: string; shipApiKey?: string; fedexAccountNumber?: string; authHeaderName?: string; shipper?: Address };
type ConnectorFile = { fedexRelay?: FedexConnection & { profiles?: Record<string, FedexConnection> } };

/**
 * 机密字段始终只从被忽略的本地文件读取。profiles 的键等于供应商连接编号；
 * 没有 profiles 时兼容原有单段 fedexRelay 配置，便于无损升级当前联调环境。
 */
@Injectable()
export class FedexRelayConfig {
  constructor(private readonly config: ConfigService) {}

  private get root() {
    const configured = this.config.get<string>('CONNECTOR_CONFIG_PATH') ?? '../../config/connectors.local.json';
    const filePath = resolve(process.cwd(), configured);
    if (!existsSync(filePath)) return {} as FedexConnection & { profiles?: Record<string, FedexConnection> };
    try { return (JSON.parse(readFileSync(filePath, 'utf8')) as ConnectorFile).fedexRelay ?? {}; }
    catch { throw new ServiceUnavailableException('接口配置文件不是有效 JSON'); }
  }

  connection(profileKey?: string): FedexConnection {
    const root = this.root;
    if (profileKey && root.profiles?.[profileKey]) return { ...root, ...root.profiles[profileKey] };
    return root;
  }

  status(profileKey?: string, requireExactProfile = false) {
    const root = this.root;
    const profileFound = !profileKey || Boolean(root.profiles?.[profileKey]);
    if (requireExactProfile && !profileFound) return { configured: false, enabled: false, environment: 'production' as const, shipperComplete: false, accountConfigured: false, profileFound };
    const values = this.connection(profileKey);
    const shipperComplete = Boolean(values.shipper?.name && values.shipper.company && values.shipper.phone && values.shipper.streetLines?.length && values.shipper.city && values.shipper.postalCode && values.shipper.countryCode);
    return { configured: Boolean(values.enabled && values.baseUrl && values.shipApiKey && values.fedexAccountNumber && values.authHeaderName && shipperComplete), enabled: values.enabled ?? false, environment: values.environment ?? 'sandbox', shipperComplete, accountConfigured: Boolean(values.fedexAccountNumber), profileFound };
  }

  hasConfiguredProductionProfile() {
    const root = this.root;
    return Object.entries(root.profiles ?? {}).some(([key]) => {
      const status = this.status(key, true);
      return status.configured && status.environment === 'production';
    });
  }

  assertReady(profileKey?: string) { if (!this.status(profileKey).configured) throw new ServiceUnavailableException(`FedEx 中转渠道配置不完整或未启用${profileKey ? `（连接：${profileKey}）` : ''}，请检查 connectors.local.json`); }
}
