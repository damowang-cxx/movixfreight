import { BadGatewayException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { UpsProfile, upsHost } from './ups-official.config';

export class UpsRequestError extends BadGatewayException {
  constructor(public readonly phase: 'OAUTH' | 'CREATE' | 'CANCEL', public readonly unknown: boolean, public readonly upstreamStatus: number | null, public readonly transactionId: string, code: string, message: string) {
    super({ message: `UPS ${phase === 'OAUTH' ? '认证' : phase === 'CREATE' ? '创建' : '取消'}失败：[${code}] ${message}`, code, errors: [{ code, message }], status: upstreamStatus ?? 502 });
  }
}
export const UPS_SHIP_PATH = '/api/shipments/v2409/ship';
export const upsCancelPath = (id: string) => `/api/shipments/v2409/void/cancel/${encodeURIComponent(id)}`;

@Injectable()
export class UpsOfficialConnector {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<string>>();
  async getAccessToken(code: string, p: UpsProfile): Promise<string> {
    const key = createHash('sha256').update(JSON.stringify([code, p.environment, p.clientId, p.clientSecret, p.shipperNumber])).digest('hex');
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const inflight = this.pending.get(key); if (inflight) return inflight;
    const request = (async () => {
      const result = await this.request(p, '/security/v1/oauth/token', 'OAUTH', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', 'x-merchant-id': p.shipperNumber }, body: 'grant_type=client_credentials' });
      const seconds = Number(result.body.expires_in);
      if (typeof result.body.access_token !== 'string' || !result.body.access_token || !Number.isFinite(seconds) || seconds <= 0) throw new UpsRequestError('OAUTH', false, result.status, result.transactionId, 'TOKEN_INVALID', '未获得有效访问令牌');
      if (this.tokens.size > 100) this.tokens.clear();
      this.tokens.set(key, { token: result.body.access_token, expiresAt: Date.now() + Math.max(0, seconds - 60) * 1000 });
      return result.body.access_token as string;
    })();
    this.pending.set(key, request);
    try { return await request; } finally { this.pending.delete(key); }
  }
  create(p: UpsProfile, token: string, payload: unknown) {
    return this.request(p, UPS_SHIP_PATH, 'CREATE', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  cancel(p: UpsProfile, token: string, shipmentId: string) {
    return this.request(p, upsCancelPath(shipmentId), 'CANCEL', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  }
  private async request(p: UpsProfile, path: string, phase: 'OAUTH' | 'CREATE' | 'CANCEL', init: RequestInit) {
    const transactionId = randomUUID().replaceAll('-', '');
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 45_000);
    try {
      const response = await fetch(upsHost(p.environment) + path, { ...init, redirect: 'error', signal: abort.signal, headers: { ...init.headers, transId: transactionId, transactionSrc: 'MOVIX' } });
      const body = await response.json() as any;
      if (!response.ok || body?.response?.errors?.length) {
        const errors = body?.response?.errors ?? body?.errors ?? [];
        // Only structured business 4xx rejections prove no creation. 5xx/malformed output is unknown.
        const known = response.status >= 400 && response.status < 500 && errors.length > 0;
        const redact = (value: string) => [p.clientId, p.clientSecret, p.shipperNumber, String((init.headers as any)?.Authorization ?? ''), String((init.headers as any)?.Authorization ?? '').replace(/^(Basic|Bearer)\s+/i, '')].filter(Boolean).reduce((s, secret) => s.split(secret).join('[REDACTED]'), value).slice(0, 1500).replace(/https?:\/\/\S+/g, '[URL]');
        throw new UpsRequestError(phase, phase !== 'OAUTH' && !known, response.status, transactionId, redact(String(errors[0]?.code ?? 'UPS_HTTP_ERROR')).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80), phase === 'OAUTH' ? 'UPS OAuth 拒绝认证，请管理员检查凭据和账号权限' : redact(errors.map((e: any) => `[${e.code ?? 'UPS_ERROR'}] ${e.message ?? '请求未通过'}`).join('；') || '供应商未返回明确处理结果，请人工核查'));
      }
      return { body, status: response.status, transactionId, method: init.method!, path };
    } catch (e) {
      if (e instanceof UpsRequestError) throw e;
      throw new UpsRequestError(phase, phase !== 'OAUTH', null, transactionId, phase === 'OAUTH' ? 'UPS_AUTH_UNAVAILABLE' : 'UPS_RESULT_UNKNOWN', phase === 'OAUTH' ? '无法取得访问令牌，尚未发送创建/取消请求' : '网络超时或无法识别响应，禁止自动重试，请人工核查');
    } finally { clearTimeout(timer); }
  }
}
