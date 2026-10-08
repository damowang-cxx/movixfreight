import { Controller, Get, Param, Post } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { CurrentUser, RequireAdminRoles, RequireAudience } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { TrackingService } from './tracking.service';

@RequireAdminRoles(AdminRole.SUPER_ADMIN, AdminRole.OPERATIONS)
@Controller('admin/v1/orders')
export class AdminTrackingController {
  constructor(private readonly tracking: TrackingService) {}
  @Get(':orderId/tracking') detail(@Param('orderId') orderId: string) { return this.tracking.detail(orderId, undefined, false, true); }
  @Post(':orderId/tracking/refresh') refresh(@Param('orderId') orderId: string) { return this.tracking.requestRefresh(orderId); }
}

@RequireAudience('customer')
@Controller('customer/v1/orders')
export class CustomerTrackingController {
  constructor(private readonly tracking: TrackingService) {}
  @Get(':orderId/tracking') detail(@CurrentUser() customer: AuthPrincipal, @Param('orderId') orderId: string) { return this.tracking.detail(orderId, customer.sub); }
}
