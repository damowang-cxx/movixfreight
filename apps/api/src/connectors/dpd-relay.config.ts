import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export type DpdRelayProfile = {
  enabled: boolean;
  environment: 'sandbox' | 'production';
  baseUrl: string;
  allowInsecureHttp?: boolean;
  ukDomesticConfirmed?: boolean;
  userId: string;
  password: string;
  customerCode: string;
  vendorName: string;
  serviceName: string;
  shipper: { name: string; contact: string; address1: string; address2?: string; city: string; state?: string; postcode: string; telephone: string; mobile?: string; email?: string };
};

@Injectable()
export class DpdRelayConfig {
  constructor(private readonly config: ConfigService) {}
  private profiles(): Record<string, DpdRelayProfile> {
    const file = resolve(process.cwd(), this.config.get<string>('CONNECTOR_CONFIG_PATH') ?? '../../config/connectors.local.json');
    if (!existsSync(file)) return {};
    try {
      const profiles = JSON.parse(readFileSync(file, 'utf8'))?.dpdRelay?.profiles;
      return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};
    } catch { throw new ServiceUnavailableException('接口配置文件不是有效 JSON'); }
  }
  status(code: string) {
    const p = this.profiles()[code];
    const missing: string[] = [];
    if (!p) missing.push(`dpdRelay.profiles.${code}`);
    for (const key of ['baseUrl', 'userId', 'password', 'customerCode', 'vendorName', 'serviceName'] as const)
      if (!p?.[key]?.trim() || p[key].trim().startsWith('填写')) missing.push(key);
    for (const key of ['name', 'contact', 'address1', 'city', 'postcode', 'telephone'] as const)
      if (!p?.shipper?.[key]?.trim() || p.shipper[key].trim().startsWith('填写')) missing.push(`shipper.${key}`);
    if (!['sandbox', 'production'].includes(p?.environment ?? '')) missing.push('environment');
    if (p?.environment === 'production' && p.ukDomesticConfirmed !== true) missing.push('ukDomesticConfirmed（确认英国本土必填字段和产品代码后设为 true）');
    if (p?.baseUrl) {
      try {
        const url = new URL(p.baseUrl);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (p.environment === 'sandbox' || p.allowInsecureHttp === true))) missing.push('baseUrl 必须使用 HTTPS；仅显式配置 allowInsecureHttp 才允许生产 HTTP');
        if (url.username || url.password || url.search || url.hash) missing.push('baseUrl 不得包含账号、查询参数或片段');
      } catch { missing.push('baseUrl 不是有效地址'); }
    }
    if (p?.shipper?.telephone && p.shipper.telephone.replace(/\D/g, '').length < 7) missing.push('shipper.telephone 需要完整号码');
    if (p?.shipper?.mobile && p.shipper.mobile.replace(/\D/g, '').length < 7) missing.push('shipper.mobile 需要完整号码');
    if (p?.shipper?.address1 && Array.from(p.shipper.address1).length > 30) missing.push('shipper.address1 超过 30 字符');
    if (p?.shipper?.address2 && Array.from(p.shipper.address2).length > 30) missing.push('shipper.address2 超过 30 字符');
    if (p?.shipper?.name && Array.from(p.shipper.name.trim()).length > 30) missing.push('shipper.name 超过 OriginName 的 30 字符限制');
    return { configured: Boolean(p?.enabled && !missing.length), enabled: p?.enabled === true, environment: p?.environment ?? null, missing };
  }
  connection(code: string, environment: string): DpdRelayProfile {
    const status = this.status(code);
    if (!status.configured) throw new ServiceUnavailableException(`DPD 渠道连接未就绪：${status.missing.join('、') || '配置未启用'}`);
    const p = this.profiles()[code]!;
    if (p.environment.toUpperCase() !== environment.toUpperCase()) throw new ServiceUnavailableException('DPD 渠道环境与供应商连接不匹配');
    return p;
  }
  accountFingerprint(p: DpdRelayProfile) {
    return createHash('sha256').update(JSON.stringify([p.environment, p.userId, p.customerCode, p.shipper.postcode])).digest('hex');
  }
}
