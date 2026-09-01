import { Module } from '@nestjs/common';
import { CustomerOrdersController } from './customer-orders.controller';
import { OrdersAdminController } from './orders-admin.controller';
import { FedexValidationService } from './fedex-validation.service';
import { OrdersService } from './orders.service';
import { PricingModule } from '../pricing/pricing.module';
import { BalanceAlertsModule } from '../balance-alerts/balance-alerts.module';
import { SettingsModule } from '../settings/settings.module';

@Module({ imports: [PricingModule, BalanceAlertsModule, SettingsModule], controllers: [CustomerOrdersController, OrdersAdminController], providers: [OrdersService, FedexValidationService], exports: [OrdersService, FedexValidationService] })
export class OrdersModule {}
