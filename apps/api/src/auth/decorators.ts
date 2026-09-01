import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AdminRole } from '@prisma/client';
import type { AuthPrincipal } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const ADMIN_ROLES_KEY = 'adminRoles';
export const RequireAdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);
export const AUDIENCE_KEY = 'audience';
export const RequireAudience = (audience: 'admin' | 'customer') => SetMetadata(AUDIENCE_KEY, audience);
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthPrincipal => context.switchToHttp().getRequest().user);
