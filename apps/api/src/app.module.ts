import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CustomersModule } from './customers/customers.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { ProductsModule } from './products/products.module';
import { PricingModule } from './pricing/pricing.module';
import { OrdersModule } from './orders/orders.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { BillingModule } from './billing/billing.module';
import { BalanceAlertsModule } from './balance-alerts/balance-alerts.module';
import { SettingsModule } from './settings/settings.module';
import { OpenApiModule } from './open-api/open-api.module';
import { TrackingModule } from './tracking/tracking.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, AuthModule, ConnectorsModule, BalanceAlertsModule, SettingsModule, CustomersModule, ProductsModule, PricingModule, OrdersModule, BillingModule, TrackingModule, OpenApiModule],
  controllers: [HealthController],
})
export class AppModule {}
