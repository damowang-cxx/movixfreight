import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { OpenApiPrincipal } from './open-api-auth.guard';

export const CurrentOpenApiCustomer = createParamDecorator((_data: unknown, context: ExecutionContext): OpenApiPrincipal => context.switchToHttp().getRequest<Request & { openApiCustomer: OpenApiPrincipal }>().openApiCustomer);
