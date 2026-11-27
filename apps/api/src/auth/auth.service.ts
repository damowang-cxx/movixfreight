import { ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import type { AuthAudience, AuthPrincipal } from './auth.types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  async loginAdmin(username: string, password: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { username }, include: { roles: true } });
    if (!admin?.enabled || !(await compare(password, admin.passwordHash))) throw new UnauthorizedException('用户名或密码错误');
    return this.issueToken({ sub: admin.id, username: admin.username, audience: 'admin', roles: admin.roles.map((item) => item.role) });
  }

  async loginCustomer(username: string, password: string) {
    const customer = await this.prisma.customer.findUnique({ where: { username } });
    if (!customer || !(await compare(password, customer.passwordHash))) throw new UnauthorizedException('用户名或密码错误');
    return this.issueToken({ sub: customer.id, username: customer.username, audience: 'customer', roles: [], customerStatus: customer.status });
  }

  async issueCustomerAssistToken(operator: AuthPrincipal, customerId: string) {
    if (operator.audience !== 'admin') throw new ForbiddenException('仅管理员可发起客户协助');
    const [admin, customer] = await Promise.all([
      this.prisma.adminUser.findUnique({ where: { id: operator.sub }, include: { roles: true } }),
      this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, customerNo: true, username: true, status: true } }),
    ]);
    const assistRoles = new Set<AdminRole>([AdminRole.SUPER_ADMIN, AdminRole.OPERATIONS, AdminRole.CUSTOMER_SERVICE]);
    if (!admin?.enabled || !admin.roles.some((item) => assistRoles.has(item.role))) throw new ForbiddenException('当前管理员无权协助客户');
    if (!customer) throw new NotFoundException('客户不存在');
    const principal: AuthPrincipal = { sub: customer.id, username: customer.username, audience: 'customer', roles: [], customerStatus: customer.status, assistedByAdminId: admin.id, assistedByAdminUsername: admin.username };
    const accessToken = this.jwt.sign(principal, { expiresIn: '15m' });
    this.logger.log(JSON.stringify({ event: 'CUSTOMER_ASSIST_STARTED', adminId: admin.id, customerId: customer.id }));
    return { accessToken, tokenType: 'Bearer', expiresInSeconds: 900, customer: { id: customer.id, customerNo: customer.customerNo, username: customer.username }, assistedBy: { id: admin.id, username: admin.username } };
  }

  private issueToken(principal: AuthPrincipal) {
    return { accessToken: this.jwt.sign(principal), tokenType: 'Bearer', principal };
  }
}
