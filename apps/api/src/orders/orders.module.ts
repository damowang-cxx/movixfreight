import { Module } from '@nestjs/common';
import { CustomerOrdersController } from './customer-orders.controller';
import { OrdersAdminController } from './orders-admin.controller';
import { FedexValidationService } from './fedex-validation.service';
import { OrdersService } from './orders.service';
import { PricingModule } from '../pricing/pricing.module';
import { BalanceAlertsModule } from '../balance-alerts/balance-alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { ShipmentDispatchQueueService } from '../open-api/shipment-dispatch-queue.service';

@Module({ imports: [PricingModule, BalanceAlertsModule, SettingsModule], controllers: [CustomerOrdersController, OrdersAdminController], providers: [OrdersService, FedexValidationService, ShipmentDispatchQueueService], exports: [OrdersService, FedexValidationService, ShipmentDispatchQueueService] })
export class OrdersModule {}
