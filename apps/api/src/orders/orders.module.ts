import { UpsShipmentService } from './ups-shipment.service';
import { UpsLabelService } from './ups-label.service';
import { ShipmentOperationsService } from './shipment-operations.service';
import { Module } from '@nestjs/common';
import { CustomerOrdersController } from './customer-orders.controller';
import { OrdersAdminController } from './orders-admin.controller';
import { FedexValidationService } from './fedex-validation.service';
import { OrdersService } from './orders.service';
import { PricingModule } from '../pricing/pricing.module';
import { BalanceAlertsModule } from '../balance-alerts/balance-alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { ShipmentDispatchQueueService } from '../open-api/shipment-dispatch-queue.service';
import { ProductsModule } from '../products/products.module';
import { LabelPdfService } from './label-pdf.service';

@Module({ imports: [PricingModule, BalanceAlertsModule, SettingsModule, ProductsModule], controllers: [CustomerOrdersController, OrdersAdminController], providers: [UpsShipmentService, UpsLabelService, ShipmentOperationsService, OrdersService, FedexValidationService, ShipmentDispatchQueueService, LabelPdfService], exports: [UpsShipmentService, UpsLabelService, ShipmentOperationsService, OrdersService, FedexValidationService, ShipmentDispatchQueueService, LabelPdfService] })
export class OrdersModule {}
