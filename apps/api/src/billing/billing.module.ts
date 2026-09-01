import { Module } from '@nestjs/common';
import { BillingAdminController } from './billing-admin.controller';
import { BillingService } from './billing.service';
import { BalanceAlertsModule } from '../balance-alerts/balance-alerts.module';
import { PricingModule } from '../pricing/pricing.module';

@Module({ imports: [BalanceAlertsModule, PricingModule], controllers: [BillingAdminController], providers: [BillingService] })
export class BillingModule {}
