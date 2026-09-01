import { Module } from '@nestjs/common';
import { SettingsAdminController } from './settings-admin.controller';
import { SettingsService } from './settings.service';

@Module({ controllers: [SettingsAdminController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
