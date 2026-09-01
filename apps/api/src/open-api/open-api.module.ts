import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PricingModule } from '../pricing/pricing.module';
import { OpenApiKeyGuard } from './open-api-auth.guard';
import { OpenApiShipmentsController } from './open-api-shipments.controller';
import { OpenApiShipmentsService } from './open-api-shipments.service';
import { ShipmentDispatchQueueService } from './shipment-dispatch-queue.service';
import { OpenApiDocsController } from './open-api-docs.controller';

@Module({ imports: [OrdersModule, PricingModule], controllers: [OpenApiShipmentsController, OpenApiDocsController], providers: [OpenApiKeyGuard, OpenApiShipmentsService, ShipmentDispatchQueueService] })
export class OpenApiModule {}
