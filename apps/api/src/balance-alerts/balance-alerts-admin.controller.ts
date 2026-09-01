import { Body, Controller, Get, Post } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { IsString, Matches } from 'class-validator';
import { CurrentUser, RequireAdminRoles } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { BalanceAlertsService } from './balance-alerts.service';

class UpdateBalanceAlertSettingsDto {
  @IsString() @Matches(/^\d+(\.\d{1,2})?$/) eurThreshold!: string;
  @IsString() @Matches(/^\d+(\.\d{1,2})?$/) gbpThreshold!: string;
}

@RequireAdminRoles(AdminRole.SUPER_ADMIN, AdminRole.FINANCE)
@Controller('admin/v1/balance-alerts')
export class BalanceAlertsAdminController {
  constructor(private readonly alerts: BalanceAlertsService) {}

  @Get('settings') listSettings() { return this.alerts.listSettings(); }
  @Post('settings') saveSettings(@Body() input: UpdateBalanceAlertSettingsDto, @CurrentUser() admin: AuthPrincipal) { return this.alerts.saveSettings(input, admin.sub); }
  @Get('notifications') listNotifications() { return this.alerts.listNotifications(); }
}
