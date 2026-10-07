import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

const ATTRIBUTES = ['elec', 'magnetic', 'danger', 'liquid', 'powder', 'paste', 'sensitive_goods', 'wood', 'textile'] as const;

export class OpenAddressDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() company?: string;
  @IsOptional() @IsString() tel?: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() state_code?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() postcode?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsObject() ext?: Record<string, unknown>;
  @IsOptional() @IsString() address_1?: string;
  @IsOptional() @IsString() address_2?: string;
  @IsOptional() @IsString() address_3?: string;
}

export class OpenDeclarationDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) weight?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) length?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) width?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) height?: number;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() name_cn?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) unit_price?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) quantity?: number;
  @IsOptional() @IsString() material?: string;
  @IsOptional() @IsString() origin_country?: string;
  @IsOptional() @IsString() hs_code?: string;
}

export class OpenParcelDto {
  @IsOptional() @IsString() number?: string;
  @IsOptional() @IsString() reference?: string;
  @Type(() => Number) @IsNumber() @Min(Number.EPSILON) client_weight!: number;
  @Type(() => Number) @IsNumber() @Min(Number.EPSILON) client_length!: number;
  @Type(() => Number) @IsNumber() @Min(Number.EPSILON) client_width!: number;
  @Type(() => Number) @IsNumber() @Min(Number.EPSILON) client_height!: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OpenDeclarationDto) declarations!: OpenDeclarationDto[];
}

export class OpenShipmentDto {
  @IsOptional() @IsString() client_reference?: string;
  /** Public service code. Supplier connections are an internal implementation detail. */
  @IsString() service!: string;
  @Type(() => Number) @IsInt() @Min(1) parcel_count!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(4) taxwith?: number;
  @IsOptional() @IsString() tax_number?: string;
  @IsOptional() @IsIn(['', 'ddu', 'ddp']) deliverywith?: '' | 'ddu' | 'ddp';
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(7) exportwith?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2) importwith?: number;
  @IsOptional() @IsArray() @IsIn(ATTRIBUTES, { each: true }) attrs?: typeof ATTRIBUTES[number][];
  @ValidateNested() @Type(() => OpenAddressDto) to_address!: OpenAddressDto;
  @IsOptional() @ValidateNested() @Type(() => OpenAddressDto) from_address?: OpenAddressDto;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OpenParcelDto) parcels!: OpenParcelDto[];
  @IsIn(['EUR', 'GBP']) declaration_currency!: 'EUR' | 'GBP';
}

export class CreateOpenShipmentDto {
  @ValidateNested() @Type(() => OpenShipmentDto) shipment!: OpenShipmentDto;
}
