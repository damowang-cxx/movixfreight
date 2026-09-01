import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import type { AuthAudience, AuthPrincipal } from './auth.types';

@Injectable()
export class AuthService {
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

  private issueToken(principal: AuthPrincipal) {
    return { accessToken: this.jwt.sign(principal), tokenType: 'Bearer', principal };
  }
}
