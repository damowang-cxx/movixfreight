import { Body, Controller, Get, Param, Patch, Post, Res } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { AdminRole, Currency, PriceVersionStatus, ProfitMode, ProfitScope } from '@prisma/client';
import { Type } from 'class-transformer';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, RequireAdminRoles } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { PricingService } from './pricing.service';

class AdminQuoteDto { @IsString() customerId!: string; @IsString() serviceId!: string; @IsString() countryCode!: string; @IsOptional() @IsString() postcode?: string; @IsArray() @IsString({ each: true }) chargeableWeightsKg!: string[]; @IsOptional() boxes?: Array<{ lengthCm: string; widthCm: string; heightCm: string }>; }
class CountryDto { @Matches(/^[A-Za-z]{2}$/) code!: string; @IsString() chineseName!: string; }
class CountryEnabledDto { @IsBoolean() enabled!: boolean; }
class CostTableDto {
  @IsString() supplierId!: string; @IsString() versionNo!: string; @IsString() countriesText!: string; @IsEnum(Currency) currency!: Currency; @IsEnum(PriceVersionStatus) status!: PriceVersionStatus; @IsString() effectiveFrom!: string; @IsString() effectiveTo!: string;
  @Matches(/^\d+(\.\d{1,3})?$/) minWeightKg!: string; @IsOptional() @Matches(/^\d+(\.\d{1,3})?$/) maxWeightKg?: string; @IsInt() minBoxes!: number; @IsOptional() @IsInt() maxBoxes?: number;
}
class PriceGridDto { @IsString() pastedText!: string; }
class ProfitRowDto { @Matches(/^[A-Za-z]{2}$/) countryCode!: string; @IsEnum(ProfitMode) mode!: ProfitMode; @Matches(/^-?\d+(\.\d{1,4})?$/) value!: string; }
class ProfitVersionDto { @IsString() serviceId!: string; @IsString() versionNo!: string; @IsEnum(ProfitScope) scope!: ProfitScope; @IsOptional() @IsString() scopeTargetId?: string | null; @IsOptional() @IsString() sourceCostVersionId?: string | null; @IsOptional() @IsEnum(ProfitMode) defaultMode?: ProfitMode; @IsOptional() @Matches(/^-?\d+(\.\d{1,4})?$/) defaultValue?: string; @IsEnum(Currency) currency!: Currency; @IsEnum(PriceVersionStatus) status!: PriceVersionStatus; @IsString() effectiveFrom!: string; @IsOptional() @IsString() effectiveTo?: string | null; @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ProfitRowDto) rows?: ProfitRowDto[]; }
class ProfitStatusDto { @IsEnum(PriceVersionStatus) status!: PriceVersionStatus; }

@ApiTags('Admin Pricing')
@RequireAdminRoles(AdminRole.SUPER_ADMIN, AdminRole.PRICING, AdminRole.OPERATIONS)
@Controller('admin/v1/pricing')
export class PricingAdminController {
  constructor(private readonly pricing: PricingService) {}
  @Get('countries') countries() { return this.pricing.countries(); }
  @Post('countries') createCountry(@Body() input: CountryDto) { return this.pricing.createCountry(input); }
  @Patch('countries/:code/enabled') setCountryEnabled(@Param('code') code: string, @Body() input: CountryEnabledDto) { return this.pricing.setCountryEnabled(code, input.enabled); }
  @Get('cost-tables') costTables() { return this.pricing.costTables(); }
  @Post('cost-tables') createCostTable(@Body() input: CostTableDto) { return this.pricing.createCostTable(input); }
  @Patch('cost-tables/:tableId') updateCostTable(@Param('tableId') tableId: string, @Body() input: CostTableDto) { return this.pricing.updateCostTable(tableId, input); }
  @Get('cost-tables/:tableId') costTable(@Param('tableId') tableId: string) { return this.pricing.costTable(tableId); }
  @Get('cost-tables/:tableId/template')
  async costTableTemplate(@Param('tableId') tableId: string, @Res() response: Response) {
    const template = await this.pricing.costTableTemplate(tableId);
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(template.filename)}"`);
    response.send(template.content);
  }
  @Get('cost-tables/:tableId/matrix-export')
  async costTableMatrixExport(@Param('tableId') tableId: string, @Res() response: Response) {
    const exportFile = await this.pricing.costTableMatrixExport(tableId);
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exportFile.filename)}"`);
    response.send(exportFile.content);
  }
  @Post('cost-tables/:tableId/price-grid/preview') previewGrid(@Param('tableId') tableId: string, @Body() input: PriceGridDto) { return this.pricing.previewPriceGrid(tableId, input.pastedText); }
  @Post('cost-tables/:tableId/price-grid/replace') replaceGrid(@Param('tableId') tableId: string, @Body() input: PriceGridDto) { return this.pricing.replacePriceGrid(tableId, input.pastedText); }
  @Get('profit-services') profitServices() { return this.pricing.profitServices(); }
  @Get('profit-services/:serviceId') profitService(@Param('serviceId') serviceId: string) { return this.pricing.profitService(serviceId); }
  @Get('profit-versions') profitVersions() { return this.pricing.profitVersions(); }
  @Get('profit-versions/:versionId/matrix-export')
  async profitMatrixExport(@Param('versionId') versionId: string, @Res() response: Response) {
    const exportFile = await this.pricing.profitMatrixExport(versionId);
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exportFile.filename)}"`);
    response.send(exportFile.content);
  }
  @Post('profit-versions') createProfitVersion(@Body() input: ProfitVersionDto, @CurrentUser() operator: AuthPrincipal) { return this.pricing.createProfitVersion(input, operator.sub); }
  @Patch('profit-versions/:versionId') updateProfitVersion(@Param('versionId') versionId: string, @Body() input: ProfitVersionDto, @CurrentUser() operator: AuthPrincipal) { return this.pricing.updateProfitVersion(versionId, input, operator.sub); }
  @Patch('profit-versions/:versionId/status') setProfitVersionStatus(@Param('versionId') versionId: string, @Body() input: ProfitStatusDto, @CurrentUser() operator: AuthPrincipal) { return this.pricing.setProfitVersionStatus(versionId, input.status, operator.sub); }
  @Post('quotes') quote(@Body() input: AdminQuoteDto) { return this.pricing.quote(input.customerId, input.serviceId, input.countryCode, input.chargeableWeightsKg, input.postcode, input.boxes); }
}
