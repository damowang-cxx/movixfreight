import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { CurrentUser, RequireAdminRoles } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { FedexValidationService } from './fedex-validation.service';
import { OrdersService } from './orders.service';

class AdminItemDto { @IsOptional() @IsString() chineseName?: string; @IsOptional() @IsString() englishName?: string; @IsOptional() @IsString() material?: string; @IsOptional() @IsString() originCountryCode?: string; @IsOptional() @IsString() harmonizedCode?: string; @IsOptional() @IsString() sku?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,3})?$/) itemWeightKg?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) itemLengthCm?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) itemWidthCm?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) itemHeightCm?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @IsInt() @Min(1) quantity?: number; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @Matches(/^\d+(\.\d{1,2})?$/) unitDeclaredValue?: string; @IsOptional() @Transform(({ value }) => value === '' ? undefined : value) @IsEnum(['EUR', 'GBP'] as const) declaredValueCurrency?: 'EUR' | 'GBP'; }
class AdminBoxDto { @IsOptional() @Transform(({ value }) => typeof value === 'string' && !value.trim() ? undefined : value) @IsString() boxNo?: string; @Matches(/^\d+(\.\d{1,3})?$/) weightKg!: string; @Matches(/^\d+(\.\d{1,2})?$/) lengthCm!: string; @Matches(/^\d+(\.\d{1,2})?$/) widthCm!: string; @Matches(/^\d+(\.\d{1,2})?$/) heightCm!: string; @IsArray() @ValidateNested({ each: true }) @Type(() => AdminItemDto) items!: AdminItemDto[]; }
class CreateAdminOrderDto { @IsString() customerId!: string; @IsString() idempotencyKey!: string; @IsString() supplierId!: string; @IsString() recipientName!: string; @IsOptional() @IsString() recipientCompany?: string; @IsOptional() @IsString() recipientPhone?: string; @IsString() recipientCountryCode!: string; @IsString() recipientPostcode!: string; @IsString() recipientCity!: string; @IsOptional() @IsString() recipientState?: string; @IsOptional() @IsString() recipientAddress?: string; @IsOptional() @IsString() recipientAddressLine1?: string; @IsOptional() @IsString() recipientAddressLine2?: string; @IsOptional() @IsString() recipientAddressLine3?: string; @IsOptional() @IsBoolean() recipientResidential?: boolean; @Matches(/^\d+(\.\d{1,3})?$/) estimatedChargeableKg!: string; @IsOptional() @IsInt() taxWith?: number; @IsOptional() @IsString() taxNumber?: string; @IsOptional() @IsString() deliveryWith?: string; @IsOptional() @IsInt() exportWith?: number; @IsOptional() @IsInt() importWith?: number; @IsOptional() @IsArray() @IsString({ each: true }) shipmentAttrs?: string[]; @IsArray() @ValidateNested({ each: true }) @Type(() => AdminBoxDto) boxes!: AdminBoxDto[]; }
class ImportOrderPayloadDto { @IsString() supplierId!: string; @IsString() recipientName!: string; @IsOptional() @IsString() recipientCompany?: string; @IsOptional() @IsString() recipientPhone?: string; @IsString() recipientCountryCode!: string; @IsString() recipientPostcode!: string; @IsString() recipientCity!: string; @IsOptional() @IsString() recipientState?: string; @IsOptional() @IsString() recipientAddress?: string; @IsOptional() @IsString() recipientAddressLine1?: string; @IsOptional() @IsString() recipientAddressLine2?: string; @IsOptional() @IsString() recipientAddressLine3?: string; @IsOptional() @IsBoolean() recipientResidential?: boolean; @Matches(/^\d+(\.\d{1,3})?$/) estimatedChargeableKg!: string; @IsOptional() @IsInt() taxWith?: number; @IsOptional() @IsString() taxNumber?: string; @IsOptional() @IsString() deliveryWith?: string; @IsOptional() @IsInt() exportWith?: number; @IsOptional() @IsInt() importWith?: number; @IsOptional() @IsArray() @IsString({ each: true }) shipmentAttrs?: string[]; @IsArray() @ValidateNested({ each: true }) @Type(() => AdminBoxDto) boxes!: AdminBoxDto[]; }
class ImportOrderDto { @IsInt() @Min(1) rowNo!: number; @IsString() customerId!: string; @ValidateNested() @Type(() => ImportOrderPayloadDto) order!: ImportOrderPayloadDto; }
class ImportOrdersDto { @IsString() sourceFileName!: string; @IsArray() @ValidateNested({ each: true }) @Type(() => ImportOrderDto) rows!: ImportOrderDto[]; }

@ApiTags('Admin Orders')
@RequireAdminRoles(AdminRole.SUPER_ADMIN, AdminRole.OPERATIONS)
@Controller('admin/v1/orders')
export class OrdersAdminController {
  constructor(private readonly fedex: FedexValidationService, private readonly orders: OrdersService) {}
  @Get()
  list() { return this.orders.listForAdmin(); }
  @Get('orderable-suppliers') orderableSuppliers() { return this.orders.orderableSuppliers(true); }
  @Get('route') route(@Query('supplierId') supplierId = '', @Query('country') country = '') { return this.orders.resolveOrderRoute(supplierId, country, true); }
  @Get('dispatch-status')
  dispatchStatus(@Query('ids') ids = '') { return this.orders.dispatchStatusesForAdmin(ids.split(',')); }
  @Post()
  create(@Body() input: CreateAdminOrderDto) { const { customerId, ...order } = input; return this.orders.createForAdmin(customerId, order); }
  @Post('import/preview')
  previewImport(@Body() input: ImportOrdersDto) { return this.orders.previewImportForAdmin(input.rows); }
  @Post('import/commit')
  commitImport(@Body() input: ImportOrdersDto) { return this.orders.importForAdmin(input.sourceFileName, input.rows); }
  @Get(':orderId')
  get(@Param('orderId') orderId: string) { return this.orders.getForAdmin(orderId); }
  @Post(':orderId/fedex/validate')
  validateFedex(@Param('orderId') orderId: string) { return this.fedex.validate(orderId); }
  @Post(':orderId/fedex/create')
  createFedex(@Param('orderId') orderId: string) { return this.fedex.create(orderId); }
  @Post(':orderId/fedex/cancel')
  cancelFedex(@Param('orderId') orderId: string, @CurrentUser() operator: AuthPrincipal) { return this.fedex.cancel(orderId, operator.sub); }
  @Get(':orderId/labels/:labelId/inline')
  async inlineLabel(@Param('orderId') orderId: string, @Param('labelId') labelId: string, @Res() response: Response) {
    const label = await this.orders.getLabelForAdmin(orderId, labelId);
    const type = label.contentType.toUpperCase().includes('PDF') || Buffer.from(label.content).subarray(0, 4).toString('ascii') === '%PDF' ? 'application/pdf' : 'application/octet-stream';
    response.setHeader('Content-Type', type); response.setHeader('Content-Disposition', `inline; filename="fedex-${label.trackingNumber ?? label.id}.${type === 'application/pdf' ? 'pdf' : 'bin'}"`); response.send(label.content);
  }
}
