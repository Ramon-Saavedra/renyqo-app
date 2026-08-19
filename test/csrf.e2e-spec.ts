import session from 'express-session';
import { Body, Controller, Get, Module, Options, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, it, jest } from '@jest/globals';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { configureCsrfProtection } from '../src/security/csrf/csrf-protection';

class MutationDto {
  value?: string;
}

@Controller('csrf-test')
class CsrfTestController {
  @Get('safe')
  safe(): { ok: boolean } {
    return { ok: true };
  }

  @Options('safe')
  options(): void {}

  @Post('mutation')
  mutation(@Body() body: MutationDto): { value: string | undefined } {
    return { value: body.value };
  }
}

@Module({
  controllers: [AuthController, CsrfTestController],
  providers: [
    {
      provide: AuthService,
      useValue: {
        register: jest.fn(),
        login: jest.fn(),
        forgotPassword: jest.fn(),
        resetPassword: jest.fn(),
      },
    },
  ],
})
class CsrfTestModule {}

describe('CSRF HTTP contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CsrfTestModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(
      session({
        secret: 'csrf-test-session-secret',
        resave: false,
        saveUninitialized: false,
      }),
    );
    configureCsrfProtection(
      app.getHttpAdapter().getInstance(),
      'https://frontend.example',
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a session-bound token and accepts it for a mutation', async () => {
    const agent = request.agent(app.getHttpServer());
    const tokenResponse = await agent
      .get('/api/v1/auth/csrf-token')
      .expect(200);
    const body: unknown = tokenResponse.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('csrfToken' in body) ||
      typeof body.csrfToken !== 'string'
    ) {
      throw new Error('CSRF token response is invalid');
    }
    const token = body.csrfToken;

    await agent
      .post('/api/v1/csrf-test/mutation')
      .set('Origin', 'https://frontend.example')
      .set('X-CSRF-Token', token)
      .send({ value: 'accepted' })
      .expect(201, { value: 'accepted' });

    await request(app.getHttpServer())
      .post('/api/v1/csrf-test/mutation')
      .set('Origin', 'https://frontend.example')
      .set('X-CSRF-Token', token)
      .send({ value: 'rejected' })
      .expect(403);
  });

  it('rejects a mutation without a token or with a mismatched Origin', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/v1/auth/csrf-token').expect(200);

    await agent
      .post('/api/v1/csrf-test/mutation')
      .set('Origin', 'https://frontend.example')
      .send({ value: 'rejected' })
      .expect(403);

    const tokenResponse = await agent
      .get('/api/v1/auth/csrf-token')
      .expect(200);
    const body: unknown = tokenResponse.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('csrfToken' in body) ||
      typeof body.csrfToken !== 'string'
    ) {
      throw new Error('CSRF token response is invalid');
    }

    await agent
      .post('/api/v1/csrf-test/mutation')
      .set('Origin', 'https://frontend.example')
      .set('X-CSRF-Token', `${body.csrfToken}-invalid`)
      .send({ value: 'rejected' })
      .expect(403);

    await agent
      .post('/api/v1/csrf-test/mutation')
      .set('Origin', 'https://attacker.example')
      .send({ value: 'rejected' })
      .expect(403);
  });

  it('supports a valid Referer and rejects invalid or conflicting origins', async () => {
    const agent = request.agent(app.getHttpServer());
    const tokenResponse = await agent
      .get('/api/v1/auth/csrf-token')
      .expect(200);
    const body: unknown = tokenResponse.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('csrfToken' in body) ||
      typeof body.csrfToken !== 'string'
    ) {
      throw new Error('CSRF token response is invalid');
    }

    await agent
      .post('/api/v1/csrf-test/mutation')
      .set('Referer', 'https://frontend.example/account')
      .set('X-CSRF-Token', body.csrfToken)
      .send({ value: 'accepted' })
      .expect(201, { value: 'accepted' });

    await agent
      .post('/api/v1/csrf-test/mutation')
      .set('Referer', 'https://attacker.example/account')
      .set('X-CSRF-Token', body.csrfToken)
      .send({ value: 'rejected' })
      .expect(403);

    await agent
      .post('/api/v1/csrf-test/mutation')
      .set('Origin', 'https://attacker.example')
      .set('Referer', 'https://frontend.example/account')
      .set('X-CSRF-Token', body.csrfToken)
      .send({ value: 'rejected' })
      .expect(403);
  });

  it('leaves safe methods unprotected', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/v1/csrf-test/safe').expect(200, { ok: true });
    await agent.head('/api/v1/csrf-test/safe').expect(200);
    await agent.options('/api/v1/csrf-test/safe').expect(200);
  });
});
