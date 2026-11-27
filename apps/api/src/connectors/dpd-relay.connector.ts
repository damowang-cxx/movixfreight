import { BadGatewayException, Injectable } from '@nestjs/common';
import type { DpdRelayProfile } from './dpd-relay.config';

export type DpdPhase = 'CREATE' | 'CANCEL' | 'TRACK' | 'PRINT';
export class DpdRequestError extends BadGatewayException {
  constructor(public readonly phase: DpdPhase, public readonly unknown: boolean, public readonly upstreamStatus: number | null, code: string, message: string, public readonly responseBody?: unknown) {
    super({ code, message: `DPD 渠道${phase === 'CREATE' ? '建单' : phase === 'CANCEL' ? '作废' : phase === 'PRINT' ? '补打' : '轨迹'}失败：${message}` });
  }
}
export const DPD_PATHS = { CREATE: '/api/v1/Awbentry/Awbentry', CANCEL: '/api/v1/Awbentry/CancelAWB', TRACK: '/api/v1/Tracking/Tracking', PRINT: '/api/v1/Awbentry/printawb' } as const;

@Injectable()
export class DpdRelayConnector {
  create(p: DpdRelayProfile, payload: unknown) { return this.request(p, 'CREATE', payload); }
  cancel(p: DpdRelayProfile, awbNo: string) { return this.request(p, 'CANCEL', { UserID: p.userId, Password: p.password, AWBNo: awbNo }); }
  track(p: DpdRelayProfile, awbNo: string) { return this.request(p, 'TRACK', { UserID: p.userId, Password: p.password, AWBNo: awbNo, Type: 'A' }); }
  print(p: DpdRelayProfile, awbNo: string) { return this.request(p, 'PRINT', { UserID: p.userId, Password: p.password, CustomerCode: p.customerCode, AWBNo: awbNo, RequiredPerforma: 'N' }); }
  private async request(p: DpdRelayProfile, phase: DpdPhase, payload: unknown) {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 45_000);
    try {
      const response = await fetch(new URL(DPD_PATHS[phase], p.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: abort.signal });
      const raw = await response.text();
      let body: any;
      try { body = JSON.parse(raw); } catch { throw new DpdRequestError(phase, phase !== 'TRACK' && phase !== 'PRINT', response.status, 'MALFORMED_RESPONSE', '渠道返回了无法解析的结果，请人工核查', { contentType: response.headers.get('content-type'), rawText: raw }); }
      if (!response.ok) throw new DpdRequestError(phase, phase !== 'TRACK' && phase !== 'PRINT', response.status, 'HTTP_ERROR', `渠道返回 HTTP ${response.status}，请人工核查`, body);
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof DpdRequestError) throw error;
      throw new DpdRequestError(phase, phase !== 'TRACK' && phase !== 'PRINT', null, 'RESULT_UNKNOWN', phase === 'TRACK' ? '轨迹暂不可用，稍后重试' : '网络超时或连接失败，禁止自动重试建单或作废，请人工核查');
    } finally { clearTimeout(timer); }
  }
}
