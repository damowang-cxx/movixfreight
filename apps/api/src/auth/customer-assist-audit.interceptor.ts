import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { tap } from 'rxjs';
import type { AuthPrincipal } from './auth.types';

@Injectable()
export class CustomerAssistAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CustomerAssistAuditInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>();
    const principal = request.user;
    if (!principal?.assistedByAdminId || !request.path.startsWith('/api/customer/v1/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next.handle();
    const audit = { event: 'CUSTOMER_ASSIST_ACTION', adminId: principal.assistedByAdminId, customerId: principal.sub, method: request.method, path: request.path };
    return next.handle().pipe(tap({ next: () => this.logger.log(JSON.stringify({ ...audit, outcome: 'SUCCESS' })), error: (error: unknown) => this.logger.warn(JSON.stringify({ ...audit, outcome: 'FAILED', status: (error as { status?: number } | null)?.status ?? 500 })) }));
  }
}
