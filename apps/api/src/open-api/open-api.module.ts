import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PricingModule } from '../pricing/pricing.module';
import { OpenApiKeyGuard } from './open-api-auth.guard';
import { OpenApiShipmentsController } from './open-api-shipments.controller';
import { OpenApiShipmentsService } from './open-api-shipments.service';
import { OpenApiDocsController } from './open-api-docs.controller';

@Module({ imports: [OrdersModule, PricingModule], controllers: [OpenApiShipmentsController, OpenApiDocsController], providers: [OpenApiKeyGuard, OpenApiShipmentsService] })
export class OpenApiModule {}
