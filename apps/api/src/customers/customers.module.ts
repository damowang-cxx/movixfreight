import { Module } from '@nestjs/common';
import { CustomersAdminController } from './customers-admin.controller';
import { CustomersService } from './customers.service';
import { BalanceAlertsModule } from '../balance-alerts/balance-alerts.module';
import { CustomerPortalController } from './customer-portal.controller';
import { ProductsModule } from '../products/products.module';
import { SettingsModule } from '../settings/settings.module';

@Module({ imports: [BalanceAlertsModule, ProductsModule, SettingsModule], controllers: [CustomersAdminController, CustomerPortalController], providers: [CustomersService] })
export class CustomersModule {}
