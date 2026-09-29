import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

export type UpsProfile = {
  enabled: boolean; environment: 'production' | 'sandbox'; clientId: string; clientSecret: string; shipperNumber: string;
  shipper: { name: string; company: string; phone: string; streetLines: string[]; city: string; postalCode: string; countryCode: string; stateCode?: string };
};
export const upsHost = (environment: UpsProfile['environment']) => environment === 'production' ? 'https://onlinetools.ups.com' : 'https://wwwcie.ups.com';

@Injectable()
export class UpsOfficialConfig {
  constructor(private readonly config: ConfigService) {}
  private profiles(): Record<string, UpsProfile> {
    const path = resolve(process.cwd(), this.config.get<string>('CONNECTOR_CONFIG_PATH') ?? '../../config/connectors.local.json');
    if (!existsSync(path)) return {};
    try { const profiles = JSON.parse(readFileSync(path, 'utf8')).upsOfficial?.profiles; return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {}; }
    catch { throw new ServiceUnavailableException('接口配置文件不是有效 JSON'); }
  }
  status(code: string) {
    return this.check(this.profiles()[code]);
  }
  private check(p: UpsProfile | undefined) {
    const text = (value: unknown): string => typeof value === 'string' ? value : '';
    const missing: string[] = [];
    if (!p) missing.push('upsOfficial.profiles.<供应商编号>');
    for (const key of ['clientId', 'clientSecret', 'shipperNumber'] as const) if (!text(p?.[key]).trim()) missing.push(key);
    if (p && !/^[A-Z0-9]{6}$/i.test(p.shipperNumber ?? '')) missing.push('shipperNumber 必须为 6 位账号');
    if (!['production', 'sandbox'].includes(p?.environment ?? '')) missing.push('environment');
    const s = p?.shipper;
    for (const key of ['name', 'company', 'phone', 'city', 'postalCode', 'countryCode'] as const) if (!text(s?.[key]).trim()) missing.push(`shipper.${key}`);
    if (s?.countryCode !== 'NL') missing.push('shipper.countryCode 必须为 NL');
    if (!Array.isArray(s?.streetLines) || !s.streetLines.length || s.streetLines.length > 3 || s.streetLines.some(line => typeof line !== 'string' || !line.trim() || Array.from(line).length > 35)) missing.push('shipper.streetLines（1–3 行，每行 35 字符）');
    if (s && (s.name?.length > 35 || s.company?.length > 35 || s.city?.length > 30 || s.postalCode?.length > 9 || (s.stateCode?.length ?? 0) > 5 || !/^\+?[\d ()-]{6,25}$/.test(s.phone ?? '') || text(s.phone).replace(/\D/g, '').length > 15)) missing.push('发件人字段长度/电话格式');
    return { configured: Boolean(p?.enabled === true && !missing.length), enabled: p?.enabled === true, environment: ['production', 'sandbox'].includes(p?.environment as string) ? p!.environment : null, profileFound: Boolean(p), shipperComplete: !missing.some(v => v.startsWith('shipper') || v.startsWith('发件人')), missing };
  }
  connection(code: string, environment: string): UpsProfile {
    const p = this.profiles()[code];
    const status = this.check(p);
    if (!status.configured) throw new ServiceUnavailableException(`UPS 连接未就绪：${status.missing.join('、') || '配置未启用'}`);
    if (p!.environment.toUpperCase() !== environment.toUpperCase()) throw new ServiceUnavailableException('UPS 供应商环境与配置 profile 不匹配');
    return p!;
  }
  /** Account changes after creation must not silently cancel against another UPS account. */
  accountFingerprint(p: UpsProfile) { return createHash('sha256').update(`${p.environment}:${p.shipperNumber}`).digest('hex'); }
}
