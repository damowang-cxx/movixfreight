export type TrackingStatus = 'LABEL_CREATED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'EXCEPTION' | 'RETURNING' | 'RETURNED' | 'UNKNOWN';
export type TrackingEventInput = { occurredAt: Date; status: TrackingStatus; carrierStatusCode: string | null; description: string; city: string | null; state: string | null; countryCode: string | null };
export type TrackingResult = { trackingNumber: string; status: TrackingStatus; carrierStatusCode: string | null; carrierDescription: string | null; events: TrackingEventInput[] };

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const date = (value: unknown) => { const parsed = new Date(text(value)); return Number.isNaN(parsed.valueOf()) ? null : parsed; };

export function fedexStatus(code: unknown): TrackingStatus {
  const value = text(code).toUpperCase();
  if (['DL', 'DELIVERED'].includes(value)) return 'DELIVERED';
  if (['OD', 'OUT_FOR_DELIVERY'].includes(value)) return 'OUT_FOR_DELIVERY';
  if (['DE', 'EX', 'EXCEPTION'].includes(value)) return 'EXCEPTION';
  if (['RS', 'RETURN_TO_SENDER', 'RETURNING'].includes(value)) return 'RETURNING';
  if (['RT', 'RETURNED'].includes(value)) return 'RETURNED';
  if (['PU', 'IT', 'AR', 'DP', 'CC', 'CD', 'AF', 'IN_TRANSIT'].includes(value)) return 'IN_TRANSIT';
  if (['OC', 'LABEL_CREATED'].includes(value)) return 'LABEL_CREATED';
  return 'UNKNOWN';
}

export function upsStatus(value: any): TrackingStatus {
  const type = text(value?.type).toUpperCase();
  const code = text(value?.code).toUpperCase();
  if (type === 'D' || code === 'DELIVERED') return 'DELIVERED';
  if (type === 'O' || code === 'OUT_FOR_DELIVERY') return 'OUT_FOR_DELIVERY';
  if (type === 'X' || code === 'EXCEPTION') return 'EXCEPTION';
  if (type === 'R' || code === 'RETURNING') return 'RETURNING';
  if (type === 'RT' || code === 'RETURNED') return 'RETURNED';
  if (['I', 'P'].includes(type) || code === 'IN_TRANSIT') return 'IN_TRANSIT';
  if (type === 'M' || code === 'LABEL_CREATED') return 'LABEL_CREATED';
  return 'UNKNOWN';
}

export function mapFedexTrack(body: any, requested: string[]): TrackingResult[] {
  const groups = Array.isArray(body?.output?.completeTrackResults) ? body.output.completeTrackResults : [];
  return requested.map(number => {
    const group = groups.find((item: any) => text(item?.trackingNumber) === number || item?.trackResults?.some((r: any) => text(r?.trackingNumberInfo?.trackingNumber) === number));
    const result = group?.trackResults?.find((r: any) => text(r?.trackingNumberInfo?.trackingNumber) === number) ?? group?.trackResults?.[0];
    const latest = result?.latestStatusDetail ?? {};
    const events: TrackingEventInput[] = (Array.isArray(result?.scanEvents) ? result.scanEvents : []).flatMap((item: any) => {
      const occurredAt = date(item?.date); if (!occurredAt) return [];
      const location = item?.scanLocation ?? {};
      return [{ occurredAt, status: fedexStatus(item?.eventType), carrierStatusCode: text(item?.eventType) || null, description: text(item?.eventDescription) || 'FedEx 扫描事件', city: text(location.city) || null, state: text(location.stateOrProvinceCode) || null, countryCode: text(location.countryCode) || null }];
    });
    const latestEvent = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
    const currentStatus = fedexStatus(latest.code);
    return { trackingNumber: number, status: result ? currentStatus === 'UNKNOWN' ? latestEvent?.status ?? 'UNKNOWN' : currentStatus : 'LABEL_CREATED', carrierStatusCode: text(latest.code) || null, carrierDescription: text(latest.description) || null, events };
  });
}

function upsActivityDate(activity: any): Date | null {
  const compact = text(activity?.gmtDate); const clock = text(activity?.gmtTime).padStart(6, '0');
  if (/^\d{8}$/.test(compact) && /^\d{6}$/.test(clock)) return date(`${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}Z`);
  const local = text(activity?.date); const time = text(activity?.time).padStart(6, '0'); const offset = text(activity?.gmtOffset);
  if (/^\d{8}$/.test(local) && /^\d{6}$/.test(time) && /^[+-]\d{2}:\d{2}$/.test(offset)) return date(`${local.slice(0, 4)}-${local.slice(4, 6)}-${local.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}${offset}`);
  return null;
}

export function mapUpsTrack(body: any, requested: string): TrackingResult {
  const shipments = body?.trackResponse?.shipment;
  const packages = (Array.isArray(shipments) ? shipments : []).flatMap((shipment: any) => Array.isArray(shipment?.package) ? shipment.package : []);
  const piece = packages.find((item: any) => text(item?.trackingNumber).toUpperCase() === requested.toUpperCase());
  const events: TrackingEventInput[] = (Array.isArray(piece?.activity) ? piece.activity : []).flatMap((item: any) => {
    const occurredAt = upsActivityDate(item); if (!occurredAt) return [];
    const address = item?.location?.address ?? {};
    return [{ occurredAt, status: upsStatus(item?.status), carrierStatusCode: text(item?.status?.code ?? item?.status?.type) || null, description: text(item?.status?.description) || 'UPS 扫描事件', city: text(address.city) || null, state: text(address.stateProvince) || null, countryCode: text(address.countryCode ?? address.country) || null }];
  });
  const current = piece?.currentStatus ?? {};
  const latestEvent = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  const currentStatus = upsStatus(current);
  return { trackingNumber: requested, status: piece ? currentStatus === 'UNKNOWN' ? latestEvent?.status ?? 'UNKNOWN' : currentStatus : 'LABEL_CREATED', carrierStatusCode: text(current.code ?? current.type) || null, carrierDescription: text(current.description) || null, events };
}
