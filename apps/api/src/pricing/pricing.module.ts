import { Module } from '@nestjs/common';
import { PricingAdminController } from './pricing-admin.controller';
import { CustomerPricingController } from './customer-pricing.controller';
import { PricingService } from './pricing.service';

@Module({ controllers: [PricingAdminController, CustomerPricingController], providers: [PricingService], exports: [PricingService] })
export class PricingModule {}
