import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { CurrentUser, RequireAdminRoles } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { WalletAdjustmentDto } from './dto/wallet-adjustment.dto';

class ClassificationCatalogDto { @IsString() code!: string; @IsString() name!: string; }
class EnabledDto { @IsBoolean() enabled!: boolean; }
class CustomerClassificationDto { @IsOptional() @IsString() customerLevelId?: string | null; @IsOptional() @IsString() customerGroupId?: string | null; @IsString() effectiveFrom!: string; }

@ApiTags('Admin Customers')
@RequireAdminRoles(AdminRole.SUPER_ADMIN, AdminRole.OPERATIONS, AdminRole.CUSTOMER_SERVICE, AdminRole.FINANCE, AdminRole.PRICING)
@Controller('admin/v1/customers')
export class CustomersAdminController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: '客户列表' })
  list() {
    return this.customers.list();
  }

  @Get('levels') levels() { return this.customers.customerLevels(); }
  @Post('levels') createLevel(@Body() input: ClassificationCatalogDto) { return this.customers.createCustomerLevel(input); }
  @Patch('levels/:levelId/enabled') setLevelEnabled(@Param('levelId') levelId: string, @Body() input: EnabledDto) { return this.customers.setCustomerLevelEnabled(levelId, input.enabled); }
  @Get('groups') groups() { return this.customers.customerGroups(); }
  @Post('groups') createGroup(@Body() input: ClassificationCatalogDto) { return this.customers.createCustomerGroup(input); }
  @Patch('groups/:groupId/enabled') setGroupEnabled(@Param('groupId') groupId: string, @Body() input: EnabledDto) { return this.customers.setCustomerGroupEnabled(groupId, input.enabled); }

  @Post()
  @ApiOperation({ summary: '管理员创建客户，并自动创建 EUR/GBP 钱包' })
  create(@Body() input: CreateCustomerDto) {
    return this.customers.createByAdmin(input);
  }

  @Get(':customerId')
  @ApiOperation({ summary: '客户详情与最近资金流水' })
  get(@Param('customerId') customerId: string) {
    return this.customers.getById(customerId);
  }

  @Patch(':customerId/classification') updateClassification(@Param('customerId') customerId: string, @Body() input: CustomerClassificationDto) { return this.customers.updateClassification(customerId, input); }

  @Post(':customerId/wallet-adjustments')
  @ApiOperation({ summary: '管理员人工余额入账或扣减' })
  adjustWallet(@Param('customerId') customerId: string, @Body() input: WalletAdjustmentDto, @CurrentUser() operator: AuthPrincipal) {
    return this.customers.adjustWallet(customerId, input, operator.sub);
  }

  @Post(':customerId/api-key')
  @ApiOperation({ summary: '创建客户 API 密钥；明文仅在本次响应中返回' })
  createApiKey(@Param('customerId') customerId: string, @CurrentUser() operator: AuthPrincipal) {
    return this.customers.createApiKey(customerId, operator.sub);
  }

  @Post(':customerId/api-key/rotate')
  @ApiOperation({ summary: '轮换客户 API 密钥；旧密钥立即失效，明文仅在本次响应中返回' })
  rotateApiKey(@Param('customerId') customerId: string, @CurrentUser() operator: AuthPrincipal) {
    return this.customers.rotateApiKey(customerId, operator.sub);
  }
}
