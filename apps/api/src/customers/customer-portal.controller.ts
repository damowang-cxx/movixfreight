import { Controller, ForbiddenException, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, RequireAudience } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { BalanceAlertsService } from '../balance-alerts/balance-alerts.service';
import { CustomersService } from './customers.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';

@RequireAudience('customer')
@Controller('customer/v1')
export class CustomerPortalController {
  constructor(private readonly customers: CustomersService, private readonly balanceAlerts: BalanceAlertsService, private readonly products: ProductsService, private readonly settings: SettingsService) {}

  @Get('account') account(@CurrentUser() customer: AuthPrincipal) { return this.customers.getPortalAccount(customer.sub); }
  @Get('notifications') notifications(@CurrentUser() customer: AuthPrincipal) { return this.balanceAlerts.listCustomerNotifications(customer.sub); }
  @Get('services') async services(@CurrentUser() customer: AuthPrincipal) { const account = await this.customers.getPortalAccount(customer.sub); if (account.status === 'FROZEN') throw new ForbiddenException('冻结客户不可查询下单服务'); return this.products.customerServices(); }
  @Get('declaration-fields') declarationFields() { return this.settings.declarationFields(); }
  @Post('notifications/:notificationId/read') markRead(@CurrentUser() customer: AuthPrincipal, @Param('notificationId') notificationId: string) { return this.balanceAlerts.markCustomerNotificationRead(customer.sub, notificationId); }
}
