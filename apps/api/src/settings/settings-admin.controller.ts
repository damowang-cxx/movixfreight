import { Body, Controller, Get, Param, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { AdminRole } from '@prisma/client';
import { CurrentUser, RequireAdminRoles, RequireAudience } from '../auth/decorators';
import type { AuthPrincipal } from '../auth/auth.types';
import { LabelTemplateInput, SettingsService } from './settings.service';

class AvatarDto { @IsString() mimeType!: string; @IsString() contentBase64!: string; }
class PasswordDto { @IsString() currentPassword!: string; @MinLength(8) newPassword!: string; }
class DeclarationFieldsDto { @IsArray() @IsString({ each: true }) requiredCodes!: string[]; }
class LabelTemplateDto implements LabelTemplateInput {
  @IsString() supplierId!: string;
  @IsString() name!: string;
  @IsString() outputFormat!: string;
  @IsString() labelStockType!: string;
  @IsOptional() @IsNumber() thermalDpi?: number | null;
  @IsOptional() @IsArray() customElements?: any[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() applyToCarrier?: boolean;
}

@ApiTags('Admin Settings')
@RequireAudience('admin')
@Controller('admin/v1/settings')
export class SettingsAdminController {
  constructor(private readonly settings: SettingsService) {}
  @Get('me') me(@CurrentUser() admin: AuthPrincipal) { return this.settings.me(admin.sub); }
  @Get('avatar') async avatar(@CurrentUser() admin: AuthPrincipal, @Res() response: Response) { const avatar = await this.settings.avatar(admin.sub); response.setHeader('Content-Type', avatar.mimeType); response.setHeader('Cache-Control', 'private, max-age=300'); response.send(avatar.content); }
  @Post('avatar') uploadAvatar(@CurrentUser() admin: AuthPrincipal, @Body() input: AvatarDto) { return this.settings.updateAvatar(admin.sub, input.mimeType, input.contentBase64); }
  @Put('password') changePassword(@CurrentUser() admin: AuthPrincipal, @Body() input: PasswordDto) { return this.settings.changePassword(admin.sub, input.currentPassword, input.newPassword); }
  @Get('declaration-fields') declarationFields() { return this.settings.declarationFields(); }
  @Put('declaration-fields') saveDeclarationFields(@CurrentUser() admin: AuthPrincipal, @Body() input: DeclarationFieldsDto) { return this.settings.saveDeclarationFields(admin.sub, input.requiredCodes, admin.roles.includes(AdminRole.SUPER_ADMIN)); }
  @Get('label-templates') labelTemplates() { return this.settings.labelTemplates(); }
  @Post('label-templates') createLabelTemplate(@CurrentUser() admin: AuthPrincipal, @Body() input: LabelTemplateDto) { return this.settings.createLabelTemplate(admin.sub, input, admin.roles.includes(AdminRole.SUPER_ADMIN)); }
  @Put('label-templates/:templateId') updateLabelTemplate(@Param('templateId') templateId: string, @CurrentUser() admin: AuthPrincipal, @Body() input: LabelTemplateDto) { return this.settings.updateLabelTemplate(templateId, admin.sub, input, admin.roles.includes(AdminRole.SUPER_ADMIN)); }
}
