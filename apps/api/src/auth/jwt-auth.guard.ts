import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ADMIN_ROLES_KEY, AUDIENCE_KEY, IS_PUBLIC_KEY } from './decorators';
import type { AuthPrincipal } from './auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('缺少访问令牌');
    try {
      request.user = this.jwt.verify<AuthPrincipal>(header.slice(7));
    } catch {
      throw new UnauthorizedException('访问令牌无效或已过期');
    }

    const principal = request.user;
    if (!principal) throw new UnauthorizedException('未识别的访问主体');

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ADMIN_ROLES_KEY, [context.getHandler(), context.getClass()]);
    const requiredAudience = this.reflector.getAllAndOverride<'admin' | 'customer'>(AUDIENCE_KEY, [context.getHandler(), context.getClass()]);
    if (requiredAudience && principal.audience !== requiredAudience) throw new ForbiddenException('当前身份无权访问此接口');
    if (requiredRoles?.length) {
      if (principal.audience !== 'admin' || !principal.roles.some((role) => requiredRoles.includes(role))) {
        throw new ForbiddenException('当前角色无权执行此操作');
      }
    }
    return true;
  }
}
