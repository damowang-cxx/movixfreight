export const currencies = ['EUR', 'GBP'] as const;
export type Currency = (typeof currencies)[number];

export const shipmentStatuses = [
  'SUBMITTED',
  'GENERATING',
  'GENERATED',
  'RECEIVED',
  'RETURNED',
  'CANCELLED',
  'FAILED',
  'UNKNOWN',
] as const;
export type ShipmentStatus = (typeof shipmentStatuses)[number];

export const feeStatuses = [
  'PRECHARGED',
  'FINAL_WEIGHT_PENDING',
  'RECONCILIATION_PENDING',
  'RECONCILED',
  'REFUNDED',
  'ADJUSTED',
] as const;
export type FeeStatus = (typeof feeStatuses)[number];

export interface Money {
  currency: Currency;
  amount: string;
}

export interface CarrierCreateResult {
  carrierTrackingNumber: string;
  labelFormat: 'PDF' | 'PNG' | 'ZPL';
  labelContent: string;
  providerReference?: string;
}

