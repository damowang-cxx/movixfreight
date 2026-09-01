import { Module } from '@nestjs/common';
import { BalanceAlertsAdminController } from './balance-alerts-admin.controller';
import { BalanceAlertsService } from './balance-alerts.service';

@Module({ controllers: [BalanceAlertsAdminController], providers: [BalanceAlertsService], exports: [BalanceAlertsService] })
export class BalanceAlertsModule {}
