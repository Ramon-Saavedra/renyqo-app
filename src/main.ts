import type { Application } from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import passport from 'passport';
import { SessionInfrastructureService } from './auth/session/session-infrastructure.service';
import { AppModule } from './app.module';
import { EnvironmentVariables, NodeEnv } from './config/env.validation';
import { configureCsrfProtection } from './security/csrf/csrf-protection';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const config = app.get(ConfigService<EnvironmentVariables, true>);
  const port = config.get('PORT', { infer: true });
  const isProd = config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
  const configuredFrontendUrl = config.get('FRONTEND_URL', { infer: true });
  if (isProd && !configuredFrontendUrl) {
    throw new Error('FRONTEND_URL is required in production');
  }
  const frontendUrl = configuredFrontendUrl ?? 'http://localhost:3001';

  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  });

  if (isProd) {
    (app.getHttpAdapter().getInstance() as Application).set('trust proxy', 1);
  }

  app.use(app.get(SessionInfrastructureService).createMiddleware());
  app.enableShutdownHooks();

  app.use(passport.initialize());
  app.use(passport.session());
  configureCsrfProtection(
    app.getHttpAdapter().getInstance() as Application,
    frontendUrl,
  );

  await app.listen(port);
}

void bootstrap();
