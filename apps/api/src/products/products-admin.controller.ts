import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ActualDataSource, AdminRole, BillingMethod, ChannelEnvironment, Currency, MeasurementMethod } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsObject, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiTags } from '@nestjs/swagger';
import { RequireAdminRoles } from '../auth/decorators';
import { ProductsService } from './products.service';

class CreateCarrierDto { @IsString() name!: string; }
class CarrierFuelSurchargeDto { @Matches(/^\d+(\.\d{1,4})?$/) percent!: string; @IsString() effectiveFrom!: string; @IsString() effectiveTo!: string; }
class SupplierDto { @IsString() carrierId!: string; @IsString() code!: string; @IsString() name!: string; @IsString() driverCode!: string; @IsEnum(ChannelEnvironment) environment!: ChannelEnvironment; @IsOptional() @IsEnum(ActualDataSource) actualDataSource?: ActualDataSource; @IsOptional() @IsObject() businessConfig?: Record<string, unknown>; }
class UpdateSupplierDto { @IsOptional() @IsString() name?: string; @IsOptional() @IsEnum(ChannelEnvironment) environment?: ChannelEnvironment; @IsOptional() @IsEnum(ActualDataSource) actualDataSource?: ActualDataSource; @IsOptional() @IsObject() businessConfig?: Record<string, unknown>; }
class SupplierEnabledDto { @IsBoolean() enabled!: boolean; }
class SupplierRouteDto { @IsString() code!: string; @IsString() name!: string; @IsEnum(['NL_DOMESTIC', 'PAN_EUROPE', 'DEFAULT'] as const) routeType!: 'NL_DOMESTIC' | 'PAN_EUROPE' | 'DEFAULT'; @IsString() serviceId!: string; @IsString() carrierServiceType!: string; @IsArray() @IsString({ each: true }) countryCodes!: string[]; @IsOptional() @IsEnum(['NONE', 'COMMODITIES'] as const) customsMode?: 'NONE' | 'COMMODITIES'; @IsOptional() @IsObject() fieldConfig?: Record<string, unknown>; @IsOptional() @IsBoolean() enabled?: boolean; }
class CreateServiceDto { @IsString() code!: string; @IsString() name!: string; @IsString() supplierId!: string; @IsOptional() @IsString() carrierServiceType?: string; @IsEnum(Currency) currency!: Currency; @IsEnum(BillingMethod) billingMethod!: BillingMethod; @IsEnum(MeasurementMethod) measurementMethod!: MeasurementMethod; @IsOptional() @Matches(/^\d+(\.\d{1,2})?$/) volumetricDivisor?: string; @IsOptional() @Matches(/^\d+(\.\d{1,3})?$/) maxActualWeightKg?: string; @IsOptional() chargeableWeightScale?: number; @IsOptional() allowsMultiPiece?: boolean; @IsOptional() minPieces?: number; }
class RemoteRuleDto { @IsString() countryCode!: string; @IsEnum(['EXACT', 'PREFIX'] as const) ruleType!: 'EXACT' | 'PREFIX'; @IsString() ruleValue!: string; }
class CreateRemoteTemplateDto { @IsString() code!: string; @IsString() name!: string; @IsOptional() @IsString() description?: string; @IsArray() @ValidateNested({ each: true }) @Type(() => RemoteRuleDto) rules!: RemoteRuleDto[]; }
class UpdateServiceRemoteConfigDto { @IsBoolean() remoteFeeEnabled!: boolean; @IsOptional() @Matches(/^\d+(\.\d{1,2})?$/) remoteFeeAmount?: string; @IsOptional() @IsString() remoteAreaTemplateId?: string; }

@ApiTags('Admin Products')
@RequireAdminRoles(AdminRole.SUPER_ADMIN, AdminRole.OPERATIONS, AdminRole.PRICING)
@Controller('admin/v1/products')
export class ProductsAdminController {
  constructor(private readonly products: ProductsService) {}
  @Get('connector-drivers') connectorDrivers() { return this.products.connectorDrivers(); }
  @Get('fedex-relay-status') fedexRelayStatus() { return this.products.fedexRelayStatus(); }
  @Get('carriers') carriers() { return this.products.carriers(); }
  @Post('carriers') createCarrier(@Body() input: CreateCarrierDto) { return this.products.createCarrier(input.name); }
  @Get('carriers/:carrierId') carrier(@Param('carrierId') carrierId: string) { return this.products.carrier(carrierId); }
  @Post('carriers/:carrierId/fuel-surcharges') createCarrierFuelSurcharge(@Param('carrierId') carrierId: string, @Body() input: CarrierFuelSurchargeDto) { return this.products.createCarrierFuelSurcharge(carrierId, input); }
  @Delete('carriers/:carrierId/fuel-surcharges/:surchargeId') deleteCarrierFuelSurcharge(@Param('carrierId') carrierId: string, @Param('surchargeId') surchargeId: string) { return this.products.deleteCarrierFuelSurcharge(carrierId, surchargeId); }
  @Delete('carriers/:carrierId') deleteCarrier(@Param('carrierId') carrierId: string) { return this.products.deleteCarrier(carrierId); }
  @Get('suppliers') suppliers() { return this.products.suppliers(); }
  @Post('suppliers') createSupplier(@Body() input: SupplierDto) { return this.products.createSupplier(input); }
  @Get('suppliers/:supplierId') supplier(@Param('supplierId') supplierId: string) { return this.products.supplier(supplierId); }
  @Patch('suppliers/:supplierId') updateSupplier(@Param('supplierId') supplierId: string, @Body() input: UpdateSupplierDto) { return this.products.updateSupplier(supplierId, input); }
  @Patch('suppliers/:supplierId/enabled') setSupplierEnabled(@Param('supplierId') supplierId: string, @Body() input: SupplierEnabledDto) { return this.products.setSupplierEnabled(supplierId, input.enabled); }
  @Delete('suppliers/:supplierId') deleteSupplier(@Param('supplierId') supplierId: string) { return this.products.deleteSupplier(supplierId); }
  @Post('suppliers/:supplierId/country-routes') createSupplierRoute(@Param('supplierId') supplierId: string, @Body() input: SupplierRouteDto) { return this.products.createSupplierRoute(supplierId, input); }
  @Patch('suppliers/:supplierId/country-routes/:routeId') updateSupplierRoute(@Param('supplierId') supplierId: string, @Param('routeId') routeId: string, @Body() input: SupplierRouteDto) { return this.products.updateSupplierRoute(supplierId, routeId, input); }
  @Delete('suppliers/:supplierId/country-routes/:routeId') deleteSupplierRoute(@Param('supplierId') supplierId: string, @Param('routeId') routeId: string) { return this.products.deleteSupplierRoute(supplierId, routeId); }
  @Get('services') services() { return this.products.services(); }
  @Post('services') createService(@Body() input: CreateServiceDto) { return this.products.createService(input); }
  @Get('remote-templates') remoteTemplates() { return this.products.remoteTemplates(); }
  @Post('remote-templates') createRemoteTemplate(@Body() input: CreateRemoteTemplateDto) { return this.products.createRemoteTemplate(input); }
  @Patch('services/:serviceId/remote-config') updateServiceRemoteConfig(@Param('serviceId') serviceId: string, @Body() input: UpdateServiceRemoteConfigDto) { return this.products.updateServiceRemoteConfig(serviceId, input); }
}
