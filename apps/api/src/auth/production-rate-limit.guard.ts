import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';

type Bucket = { count: number; resetAt: number };

/** Lightweight perimeter protection for login and Open API on the single production API instance. */
@Injectable()
export class ProductionRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;
    const isLogin = path === '/api/auth/admin/login' || path === '/api/auth/customer/login';
    const isOpen = path.startsWith('/api/open/v1/');
    if (!isLogin && !isOpen) return true;
    const limit = isLogin ? 12 : 120;
    const windowMs = 60_000;
    const key = `${isLogin ? 'login' : 'open'}:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`;
    const now = Date.now(); const current = this.buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1; this.buckets.set(key, bucket);
    if (bucket.count > limit) throw new HttpException('请求过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    if (this.buckets.size > 10_000) for (const [entryKey, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(entryKey);
    return true;
  }
}
