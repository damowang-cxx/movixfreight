import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/decorators';
import { PrismaService } from '../database/prisma.service';
import { FedexRelayConfig } from '../connectors/fedex-relay.config';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly fedex: FedexRelayConfig) {}
  @Get()
  getHealth() {
    return {
      service: 'movix-freight-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    try { await this.prisma.$queryRawUnsafe('SELECT 1'); }
    catch { throw new ServiceUnavailableException('数据库未就绪'); }
    const productionRequired = this.config.get<string>('NODE_ENV') === 'production';
    const jwtReady = Boolean(this.config.get<string>('JWT_SECRET')) && this.config.get<string>('JWT_SECRET') !== 'development-only-secret-change-me';
    if (productionRequired && !jwtReady) throw new ServiceUnavailableException('生产 JWT 密钥未配置');
    return { service: 'movix-freight-api', status: 'ready', workerEnabled: this.config.get<string>('DISPATCH_WORKER_ENABLED') !== 'false', fedexProductionProfileConfigured: productionRequired ? this.fedex.hasConfiguredProductionProfile() : undefined, timestamp: new Date().toISOString() };
  }
}
