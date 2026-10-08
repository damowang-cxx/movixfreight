import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CurrentUser, RequireAudience } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { OrdersService } from './orders.service';
import { LabelPdfService } from './label-pdf.service';
import { TrackingService } from '../tracking/tracking.service';

class ItemDto { @IsOptional() @IsString() chineseName?: string; @IsOptional() @IsString() englishName?: string; @IsOptional() @IsString() material?: string; @IsOptional() @IsString() originCountryCode?: string; @IsOptional() @IsString() harmonizedCode?: string; @IsOptional() @IsString() sku?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,3})?$/) itemWeightKg?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) itemLengthCm?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) itemWidthCm?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) itemHeightCm?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @IsInt() @Min(1) quantity?: number; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) unitDeclaredValue?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @IsEnum(['EUR', 'GBP'] as const) declaredValueCurrency?: 'EUR' | 'GBP'; }
class BoxDto { @IsOptional() @Transform(({ value }) => typeof value === 'string' && !value.trim() ? undefined : value) @IsString() boxNo?: string; @Matches(/^\d+(\.\d{1,3})?$/) weightKg!: string; @Matches(/^\d+(\.\d{1,2})?$/) lengthCm!: string; @Matches(/^\d+(\.\d{1,2})?$/) widthCm!: string; @Matches(/^\d+(\.\d{1,2})?$/) heightCm!: string; @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[]; }
class CreateOrderDto { @IsString() idempotencyKey!: string; @IsString() supplierId!: string; @IsString() recipientName!: string; @IsOptional() @IsString() recipientCompany?: string; @IsOptional() @IsString() recipientPhone?: string; @IsString() recipientCountryCode!: string; @IsString() recipientPostcode!: string; @IsString() recipientCity!: string; @IsOptional() @IsString() recipientState?: string; @IsOptional() @IsString() recipientAddress?: string; @IsOptional() @IsString() recipientAddressLine1?: string; @IsOptional() @IsString() recipientAddressLine2?: string; @IsOptional() @IsString() recipientAddressLine3?: string; @IsOptional() recipientResidential?: boolean; @Matches(/^\d+(\.\d{1,3})?$/) estimatedChargeableKg!: string; @IsOptional() @IsInt() taxWith?: number; @IsOptional() @IsString() taxNumber?: string; @IsOptional() @IsString() deliveryWith?: string; @IsOptional() @IsInt() exportWith?: number; @IsOptional() @IsInt() importWith?: number; @IsOptional() @IsArray() @IsString({ each: true }) shipmentAttrs?: string[]; @IsArray() @ValidateNested({ each: true }) @Type(() => BoxDto) boxes!: BoxDto[]; }

@ApiTags('Customer Orders')
@RequireAudience('customer')
@Controller('customer/v1/orders')
export class CustomerOrdersController {
  constructor(private readonly orders: OrdersService, private readonly labelPdf: LabelPdfService, private readonly tracking: TrackingService) {}
  @Get('orderable-suppliers') suppliers() { return this.orders.orderableSuppliers(false); }
  @Get('route') route(@Query('supplierId') supplierId = '', @Query('country') country = '') { return this.orders.resolveOrderRoute(supplierId, country, false); }
  @Post() create(@CurrentUser() customer: AuthPrincipal, @Body() input: CreateOrderDto) { return this.orders.createForCustomer(customer.sub, input); }
  @Post('quote') quote(@CurrentUser() customer: AuthPrincipal, @Body() input: CreateOrderDto) { return this.orders.quoteForCustomer(customer.sub, input); }
  @Get() list(@CurrentUser() customer: AuthPrincipal) { return this.orders.listForCustomer(customer.sub); }
  @Get('dispatch-status') dispatchStatus(@CurrentUser() customer: AuthPrincipal, @Query('ids') ids = '') { return this.orders.dispatchStatusesForCustomer(customer.sub, ids.split(',')); }
  @Get('tracking-status') trackingStatus(@CurrentUser() customer: AuthPrincipal, @Query('ids') ids = '') { return this.tracking.statuses(ids, customer.sub); }
  @Get(':orderId') get(@CurrentUser() customer: AuthPrincipal, @Param('orderId') orderId: string) { return this.orders.getForCustomer(customer.sub, orderId); }
  @Get(':orderId/labels/:labelId/download')
  async downloadLabel(@CurrentUser() customer: AuthPrincipal, @Param('orderId') orderId: string, @Param('labelId') labelId: string, @Res() response: Response) {
    const label = await this.orders.getLabelForCustomer(customer.sub, orderId, labelId);
    const type = label.contentType.toUpperCase().includes('PDF') || Buffer.from(label.content).subarray(0, 4).toString('ascii') === '%PDF' ? 'application/pdf' : 'application/octet-stream';
    const filename = `label-${label.trackingNumber ?? label.id}.${type === 'application/pdf' ? 'pdf' : 'bin'}`;
    const content = type === 'application/pdf' ? await this.labelPdf.forPreviewOrDownload(label.content, label.contentType, label.sourceContent ? 'UPS_OFFICIAL' : 'FEDEX_RELAY') : label.content;
    response.setHeader('Content-Type', type); response.setHeader('Content-Disposition', `attachment; filename="${filename}"`); response.send(content);
  }
}
