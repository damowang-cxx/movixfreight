import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AdminRole, Currency } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { CurrentUser, RequireAdminRoles } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { BillingService } from './billing.service';

class SupplierBillRowDto {
  @IsInt() @Min(1) lineNo!: number;
  @IsOptional() @IsString() trackingNumber?: string;
  @IsOptional() @Matches(/^\d+(\.\d{1,3})?$/) supplierActualWeightKg?: string;
  @IsOptional() @Matches(/^\d+(\.\d{1,3})?$/) finalChargeableWeightKg?: string;
  @IsOptional() @Matches(/^\d+(\.\d{1,2})?$/) supplierFinalCost?: string;
  @IsOptional() @IsEnum(Currency) currency?: Currency;
  @IsObject() rawData!: Record<string, unknown>;
}

class CreateSupplierBillImportDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() channelId?: string;
  @IsString() originalFilename!: string;
  @IsEnum(Currency) currency!: Currency;
  @IsOptional() @IsDateString() billingPeriodFrom?: string;
  @IsOptional() @IsDateString() billingPeriodTo?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SupplierBillRowDto) rows!: SupplierBillRowDto[];
}

class ConfirmReconciliationDto {
  @Matches(/^\d+(\.\d{1,2})?$/) finalReceivableAmount!: string;
  @IsOptional() @IsString() confirmationNote?: string;
}
class RecalculationBoxDto { @IsString() boxId!: string; @Matches(/^\d+(\.\d{1,3})?$/) finalChargeableWeightKg!: string; }
class RecalculateReconciliationDto { @IsOptional() @IsDateString() asOfDate?: string; @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RecalculationBoxDto) boxes?: RecalculationBoxDto[]; }
class ConfirmCancellationRefundDto { @IsBoolean() approved!: boolean; @IsOptional() @IsString() confirmationNote?: string; }

@RequireAdminRoles(AdminRole.SUPER_ADMIN, AdminRole.FINANCE)
@Controller('admin/v1/billing')
export class BillingAdminController {
  constructor(private readonly billing: BillingService) {}

  @Get('imports')
  listImports() { return this.billing.listImports(); }

  @Get('imports/:batchId')
  getImport(@Param('batchId') batchId: string) { return this.billing.getImport(batchId); }

  /** Receives rows normalized by the future CSV/XLSX mapping layer. No customer money is changed here. */
  @Post('imports')
  createImport(@Body() input: CreateSupplierBillImportDto, @CurrentUser() operator: AuthPrincipal) {
    return this.billing.createImport(input, operator.sub);
  }

  /** Copies matched carrier actuals to orders and creates finance-review cases. No wallet ledger is written. */
  @Post('imports/:batchId/apply')
  applyImport(@Param('batchId') batchId: string, @CurrentUser() operator: AuthPrincipal) {
    return this.billing.applyImport(batchId, operator.sub);
  }

  @Get('reconciliations')
  listReconciliations() { return this.billing.listReconciliations(); }

  @Get('cancellation-refunds')
  listCancellationRefunds() { return this.billing.listCancellationRefunds(); }

  @Post('cancellation-refunds/:caseId/confirm')
  confirmCancellationRefund(@Param('caseId') caseId: string, @Body() input: ConfirmCancellationRefundDto, @CurrentUser() operator: AuthPrincipal) {
    return this.billing.confirmCancellationRefund(caseId, input, operator.sub);
  }

  @Post('reconciliations/:reconciliationId/recalculate')
  recalculate(@Param('reconciliationId') reconciliationId: string, @Body() input: RecalculateReconciliationDto, @CurrentUser() operator: AuthPrincipal) {
    return this.billing.recalculate(reconciliationId, input, operator.sub);
  }

  @Post('reconciliations/:reconciliationId/confirm')
  confirmReconciliation(@Param('reconciliationId') reconciliationId: string, @Body() input: ConfirmReconciliationDto, @CurrentUser() operator: AuthPrincipal) {
    return this.billing.confirmReconciliation(reconciliationId, input, operator.sub);
  }
}
