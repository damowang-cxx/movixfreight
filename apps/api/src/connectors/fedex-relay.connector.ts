import { BadGatewayException, GatewayTimeoutException, Injectable } from '@nestjs/common';
import { FedexRelayConfig } from './fedex-relay.config';

export type FedexRelayPayload = Record<string, unknown>;
export type FedexLabel = { trackingNumber?: string; contentType: string; encodedLabel: string };

/** direct.ship-api.com/fedex 的已确认接口：OAuth、Rate、Validate、Create、Cancel。 */
@Injectable()
export class FedexRelayConnector {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  constructor(private readonly config: FedexRelayConfig) {}

  async getAccessToken(profileKey?: string) {
    this.config.assertReady(profileKey); const connection = this.config.connection(profileKey);
    const response = await this.fetchWithTimeout(`${connection.baseUrl!.replace(/\/$/, '')}/oauth/token`, { method: 'POST', headers: { [connection.authHeaderName!]: `Bearer ${connection.shipApiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }, 'FedEx 中转站 OAuth 授权');
    const body = await this.json(response);
    if (!response.ok || typeof body.access_token !== 'string') throw new BadGatewayException('FedEx 中转站 OAuth 授权失败');
    return { accessToken: body.access_token, expiresIn: Number(body.expires_in ?? 0) };
  }

  async rate(token: string, payload: FedexRelayPayload, profileKey?: string) { return this.post('/rate/v1/rates/quotes', token, payload, profileKey); }
  async validate(token: string, payload: FedexRelayPayload, profileKey?: string) { return this.post('/ship/v1/shipments/packages/validate', token, payload, profileKey); }
  async createShipment(token: string, payload: FedexRelayPayload, profileKey?: string) { return this.post('/ship/v1/shipments', token, payload, profileKey); }
  /**
   * FedEx Ship API 的取消接口。取消只针对尚未交运/收货的运单；国际多件 Express
   * 以主运单号配合 DELETE_ALL_PACKAGES 取消整票，避免只删除其中一个包裹。
   */
  async cancelShipment(token: string, trackingNumber: string, profileKey?: string) {
    this.config.assertReady(profileKey);
    const connection = this.config.connection(profileKey);
    // Ship-API Direct exposes its own FedEx cancellation adapter.  It is not
    // the native FedEx DELETE endpoint: the tracking number is in the body
    // and the adapter requires PUT /ship/v1/shipments/cancel.
    return this.put('/ship/v1/shipments/cancel', token, {
      accountNumber: { value: connection.fedexAccountNumber },
      trackingNumber,
      deletionControl: 'DELETE_ALL_PACKAGES',
    }, profileKey);
  }

  extractLabels(result: any): { masterTrackingNumber?: string; labels: FedexLabel[] } {
    const shipments = result?.output?.transactionShipments ?? []; const labels: FedexLabel[] = []; let masterTrackingNumber: string | undefined;
    for (const shipment of shipments) { masterTrackingNumber ??= shipment.masterTrackingNumber; for (const piece of shipment.pieceResponses ?? []) { const trackingNumber = piece.trackingNumber ?? piece.masterTrackingNumber ?? masterTrackingNumber; for (const document of piece.packageDocuments ?? []) { const encodedLabel = document.encodedLabel ?? document.documentContent ?? document.content; if (encodedLabel) { const content = Buffer.from(encodedLabel, 'base64'); const contentType = content.subarray(0, 4).toString('ascii') === '%PDF' ? 'application/pdf' : document.contentType ?? 'application/octet-stream'; labels.push({ trackingNumber, contentType, encodedLabel }); } } } }
    return { masterTrackingNumber, labels };
  }

  private async post(path: string, token: string, payload: FedexRelayPayload, profileKey?: string) {
    this.config.assertReady(profileKey); const connection = this.config.connection(profileKey);
    const response = await this.fetchWithTimeout(`${connection.baseUrl!.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, [connection.authHeaderName!]: `Bearer ${connection.shipApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 'FedEx 中转站请求');
    const body = await this.json(response);
    if (!response.ok) throw new BadGatewayException({ message: 'FedEx 中转站调用失败', status: response.status, errors: body.errors ?? body.output?.alerts ?? body.message ?? null });
    return body;
  }

  private async put(path: string, token: string, payload: FedexRelayPayload, profileKey?: string) {
    this.config.assertReady(profileKey); const connection = this.config.connection(profileKey);
    const response = await this.fetchWithTimeout(`${connection.baseUrl!.replace(/\/$/, '')}${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, [connection.authHeaderName!]: `Bearer ${connection.shipApiKey}`, 'Content-Type': 'application/json', 'x-locale': 'en_US' }, body: JSON.stringify({ ...payload, emailReturnShipment: false }) }, 'FedEx 中转站取消运单请求');
    const body = await this.json(response);
    if (!response.ok) throw new BadGatewayException({ message: 'FedEx 中转站取消运单失败', status: response.status, errors: body.errors ?? body.output?.alerts ?? body.message ?? null });
    return body;
  }

  private async json(response: Response): Promise<any> { try { return await response.json(); } catch { return {}; } }

  private async fetchWithTimeout(url: string, init: RequestInit, operation: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FedexRelayConnector.REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GatewayTimeoutException(`${operation}超过 30 秒未返回。供应商是否已处理无法确认，请勿重复提交，系统已标记为“结果未知”等待人工核查。`);
      }
      throw new BadGatewayException(`${operation}网络连接失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
