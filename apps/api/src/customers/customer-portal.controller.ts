import { Controller, ForbiddenException, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, RequireAudience } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { BalanceAlertsService } from '../balance-alerts/balance-alerts.service';
import { CustomersService } from './customers.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import { PricingService } from '../pricing/pricing.service';

@RequireAudience('customer')
@Controller('customer/v1')
export class CustomerPortalController {
  constructor(private readonly customers: CustomersService, private readonly balanceAlerts: BalanceAlertsService, private readonly products: ProductsService, private readonly settings: SettingsService, private readonly pricing: PricingService) {}

  @Get('account') account(@CurrentUser() customer: AuthPrincipal) { return this.customers.getPortalAccount(customer.sub); }
  @Get('recharges') recharges(@CurrentUser() customer: AuthPrincipal, @Query('cursor') cursor?: string) { return this.customers.rechargeHistory(customer.sub, false, cursor); }
  @Get('recharges/:ledgerId/receipt') async rechargeReceipt(@CurrentUser() customer: AuthPrincipal, @Param('ledgerId') ledgerId: string, @Res() response: Response) {
    const receipt = await this.customers.rechargeReceipt(customer.sub, ledgerId);
    response.setHeader('Content-Type', receipt.mimeType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(Buffer.from(receipt.content));
  }
  @Get('notifications') notifications(@CurrentUser() customer: AuthPrincipal) { return this.balanceAlerts.listCustomerNotifications(customer.sub); }
  @Get('services') async services(@CurrentUser() customer: AuthPrincipal) { const account = await this.customers.getPortalAccount(customer.sub); if (account.status === 'FROZEN') throw new ForbiddenException('冻结客户不可查询下单服务'); return this.products.customerServices(); }
  @Get('declaration-fields') declarationFields() { return this.settings.declarationFields(); }
  @Get('countries') countries() { return this.pricing.countries(); }
  @Post('notifications/:notificationId/read') markRead(@CurrentUser() customer: AuthPrincipal, @Param('notificationId') notificationId: string) { return this.balanceAlerts.markCustomerNotificationRead(customer.sub, notificationId); }
}
