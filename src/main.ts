import type { Application } from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { AppModule } from './app.module';
import { EnvironmentVariables, NodeEnv } from './config/env.validation';

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
  const secret = config.get('SESSION_SECRET', { infer: true });
  const databaseUrl = config.get('DATABASE_URL', { infer: true });
  const isProd = config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
  const frontendUrl =
    config.get('FRONTEND_URL', { infer: true }) ?? 'http://localhost:3001';

  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  });

  if (isProd) {
    (app.getHttpAdapter().getInstance() as Application).set('trust proxy', 1);
  }

  const PgStore = connectPgSimple(session);

  app.use(
    session({
      name: 'sid',
      secret,
      resave: false,
      saveUninitialized: false,
      store: new PgStore({
        conString: databaseUrl,
        tableName: 'user_sessions',
        createTableIfMissing: false,
      }),
      cookie: {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  app.use(passport.initialize());
  app.use(passport.session());

  await app.listen(port);
}

void bootstrap();
