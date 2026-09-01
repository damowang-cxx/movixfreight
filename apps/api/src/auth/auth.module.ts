import { Global, Module } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ProductionRateLimitGuard } from './production-rate-limit.guard';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (config.get<string>('NODE_ENV') === 'production' && (!secret || secret === 'development-only-secret-change-me')) throw new Error('生产环境必须配置安全的 JWT_SECRET');
        return { secret: secret ?? 'development-only-secret-change-me', signOptions: { expiresIn: Number(config.get<string>('JWT_EXPIRES_IN_SECONDS') ?? 28800) } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    ProductionRateLimitGuard,
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, jwt: JwtService) => new JwtAuthGuard(reflector, jwt),
      inject: [Reflector, JwtService],
    },
    { provide: APP_GUARD, useExisting: ProductionRateLimitGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
