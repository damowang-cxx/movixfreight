import type { TrackingResult, TrackingStatus } from '../tracking/tracking.mapper';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export function dpdTrackingStatus(value: unknown): TrackingStatus {
  const status = text(value).toUpperCase();
  if (/NOT RECEIVED|AWAITING COLLECTION/.test(status)) return 'LABEL_CREATED';
  if (/NOT DELIVERED|DELIVERY FAILED|FAILED DELIVERY|ATTEMPTED DELIVERY/.test(status)) return 'EXCEPTION';
  if (/DELIVERED|SIGNED FOR|RECEIVED BY CONSIGNEE/.test(status)) return 'DELIVERED';
  if (/OUT FOR DELIVERY|ON VEHICLE FOR DELIVERY/.test(status)) return 'OUT_FOR_DELIVERY';
  if (/RETURNED TO SENDER/.test(status)) return 'RETURNED';
  if (/RETURN TO SENDER|RETURNING/.test(status)) return 'RETURNING';
  if (/EXCEPTION|FAILED|DAMAGED|LOST|REFUSED/.test(status)) return 'EXCEPTION';
  if (/RECEIVED|COLLECTED|IN TRANSIT|SENT TO DESTINATION|SORTED|ARRIVED|DEPARTED/.test(status)) return 'IN_TRANSIT';
  if (/LABEL|BOOKED|CREATED/.test(status)) return 'LABEL_CREATED';
  return 'UNKNOWN';
}
function eventDate(date: unknown, time: unknown) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text(date));
  const clock = text(time).replace(/:/g, '').padStart(4, '0');
  if (!match || !/^\d{4}$/.test(clock)) return null;
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]), hour = Number(clock.slice(0, 2)), minute = Number(clock.slice(2));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(check).find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = Number(/^GMT\+(\d+)$/.exec(zone)?.[1] ?? 0);
  return new Date(utc - offset * 3600_000);
}
export function mapDpdTrack(body: any, awbNo: string): TrackingResult {
  if (String(body?.ErrorCode) !== '0' || !Array.isArray(body?.Tracking)) throw new Error('DPD 渠道轨迹响应无效');
  const events = body.Tracking.flatMap((row: any) => {
    const occurredAt = eventDate(row?.EventDate, row?.EventTime);
    if (!occurredAt) return [];
    const description = text(row?.Status) || '渠道扫描事件';
    return [{ occurredAt, status: dpdTrackingStatus(description), carrierStatusCode: null, description, city: text(row?.Location) || null, state: null, countryCode: 'GB' }];
  });
  const latest = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  const summary = body.Tracking.find((row: any) => row?.AWBNo) ?? {};
  const description = text(summary.Status) || latest?.description || '';
  const status = dpdTrackingStatus(description);
  return { trackingNumber: awbNo, status: status === 'UNKNOWN' ? latest?.status ?? 'LABEL_CREATED' : status, carrierStatusCode: null, carrierDescription: description || null, events };
}
