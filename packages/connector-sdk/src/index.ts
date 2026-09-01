import type { CarrierCreateResult, Currency } from '@movix/shared-types';

export type ConnectorOperation = 'CREATE_SHIPMENT' | 'CANCEL_SHIPMENT' | 'QUERY_SHIPMENT' | 'TRACK_SHIPMENT';

export interface ConnectorCredentials {
  channelCode: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  encryptedConfig: Record<string, string>;
}

export interface ShipmentBoxInput {
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

export interface CreateShipmentInput {
  internalOrderNo: string;
  idempotencyKey: string;
  serviceCode: string;
  currency: Currency;
  recipient: {
    name: string;
    countryCode: string;
    postcode: string;
    city: string;
    addressLine1: string;
    phone?: string;
  };
  boxes: ShipmentBoxInput[];
}

export interface CancelShipmentInput {
  internalOrderNo: string;
  carrierTrackingNumber: string;
}

export interface QueryShipmentResult {
  found: boolean;
  carrierTrackingNumber?: string;
  status?: string;
}

export interface CarrierConnector {
  readonly driverCode: string;
  validateOrder(input: CreateShipmentInput): Promise<string[]>;
  createShipment(credentials: ConnectorCredentials, input: CreateShipmentInput): Promise<CarrierCreateResult>;
  cancelShipment(credentials: ConnectorCredentials, input: CancelShipmentInput): Promise<void>;
  queryShipment(credentials: ConnectorCredentials, internalOrderNo: string): Promise<QueryShipmentResult>;
}

