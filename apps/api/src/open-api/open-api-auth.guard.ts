import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service';

export type OpenApiPrincipal = { customerId: string; customerNo: string; username: string; status: string };

@Injectable()
export class OpenApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & { openApiCustomer?: OpenApiPrincipal }>();
    const value = request.headers['x-api-key'];
    const apiKey = Array.isArray(value) ? value[0] : value;
    const prefix = typeof apiKey === 'string' ? apiKey.split('.', 1)[0] : undefined;
    if (!apiKey || !prefix || !/^mvx_[a-f0-9]+$/i.test(prefix)) throw new UnauthorizedException('API Key 无效');
    const record = await this.prisma.customerApiKey.findFirst({ where: { keyPrefix: prefix }, include: { customer: { select: { id: true, customerNo: true, username: true, status: true } } } });
    if (!record || !(await compare(apiKey, record.secretHash))) throw new UnauthorizedException('API Key 无效');
    request.openApiCustomer = { customerId: record.customer.id, customerNo: record.customer.customerNo, username: record.customer.username, status: record.customer.status };
    return true;
  }
}
