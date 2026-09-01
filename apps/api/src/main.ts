import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  const configuredOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001,http://localhost:3002').split(',');
  const localIpv4Origins = process.env.NODE_ENV === 'production' ? [] : ['http://127.0.0.1:3001', 'http://127.0.0.1:3002'];
  const origins = [...new Set([...configuredOrigins, ...localIpv4Origins])];

  app.enableCors({ origin: origins, credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));

  const config = new DocumentBuilder()
    .setTitle('Movix Freight API')
    .setDescription('中国至欧洲尾程打单、计费与账单管理 API')
    .setVersion('v1')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
