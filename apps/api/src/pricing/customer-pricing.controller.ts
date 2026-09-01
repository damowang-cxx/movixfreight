import { Body, Controller, Post } from '@nestjs/common';
import { IsArray, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireAudience } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { PricingService } from './pricing.service';

class QuoteBoxDto { @Matches(/^\d+(\.\d{1,2})?$/) lengthCm!: string; @Matches(/^\d+(\.\d{1,2})?$/) widthCm!: string; @Matches(/^\d+(\.\d{1,2})?$/) heightCm!: string; }
class QuoteDto { @IsString() serviceId!: string; @IsString() countryCode!: string; @IsOptional() @IsString() postcode?: string; @IsArray() @IsString({ each: true }) chargeableWeightsKg!: string[]; @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuoteBoxDto) boxes?: QuoteBoxDto[]; }

@ApiTags('Customer Pricing')
@RequireAudience('customer')
@Controller('customer/v1/quotes')
export class CustomerPricingController {
  constructor(private readonly pricing: PricingService) {}
  @Post()
  quote(@CurrentUser() customer: AuthPrincipal, @Body() input: QuoteDto) { return this.pricing.quote(customer.sub, input.serviceId, input.countryCode, input.chargeableWeightsKg, input.postcode, input.boxes); }
}
