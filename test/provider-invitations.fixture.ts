import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { EmailService } from '../src/email/email.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';
import { installE2eSessionMiddleware } from './e2e-session-middleware';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import type { MemberColor } from '../src/member-presentation/member-color.catalog';
export class InvitationFixture {
  readonly db = new ListingWorkspaceFixture();
  app!: INestApplication;
  w!: Awaited<ReturnType<ListingWorkspaceFixture['organization']>>;
  readonly mail: { to: string; subject: string; url: string }[] = [];
  readonly transport = {
    assertSecurityDeliveryConfigured: jest.fn(),
    sendSecurityLink: jest.fn(
      (input: { to: string; subject: string; url: string }) => {
        this.mail.push(input);
        return Promise.resolve();
      },
    ),
  };
  private readonly previous = {
    resend: process.env['INVITATION_RESEND_COOLDOWN_SECONDS'],
    verify: process.env['EMAIL_VERIFICATION_COOLDOWN_SECONDS'],
  };
  async start() {
    await this.db.start();
    this.w = await this.db.organization();
    await this.db.prisma.user.update({
      where: { id: this.w.ownerUser },
      data: { passwordHash: await bcrypt.hash('StrongPass123', 12) },
    });
    await this.db.activateApplication();
    process.env['SESSION_SECRET'] =
      'invitation-e2e-session-secret-at-least-thirty-two-characters';
    process.env['INVITATION_RESEND_COOLDOWN_SECONDS'] = '0';
    process.env['EMAIL_VERIFICATION_COOLDOWN_SECONDS'] = '0';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(
        prismaServiceWithSharedPool(
          this.db.applicationRuntime,
          this.db.applicationPool,
          this.db.schema,
        ),
      )
      .overrideProvider(EmailService)
      .useValue(this.transport)
      .compile();
    this.app = module.createNestApplication();
    this.app.setGlobalPrefix('api/v1');
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    installE2eSessionMiddleware(this.app);
    await this.app.init();
  }
  client() {
    return request.agent(
      this.app.getHttpServer() as Parameters<typeof request>[0],
    );
  }
  async owner() {
    const c = this.client();
    const u = await this.db.prisma.user.findUniqueOrThrow({
      where: { id: this.w.ownerUser },
    });
    await c
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: 'StrongPass123' })
      .expect(200);
    return c;
  }
  async account(email = `${randomUUID()}@invite.test`) {
    const client = this.client();
    const response = await client
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'StrongPass123',
        name: 'Invited member',
        role: 'provider',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    return { client, email, id: (response.body as { id: string }).id };
  }
  secret(to: string, subject: string) {
    const mail = this.mail
      .filter((m) => m.to === to && m.subject.includes(subject))
      .at(-1);
    if (!mail) throw new Error('Expected captured security email');
    return new URLSearchParams(new URL(mail.url).hash.slice(1)).get('token')!;
  }
  async verify(account: Awaited<ReturnType<InvitationFixture['account']>>) {
    await account.client
      .post('/api/v1/auth/email-verification/request')
      .send({})
      .expect(200);
    const token = this.secret(account.email, 'Verify');
    await account.client
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token })
      .expect(200);
    return token;
  }
  async invite(
    owner: ReturnType<InvitationFixture['client']>,
    email: string,
    commandId = randomUUID(),
    requestedColorId?: MemberColor,
  ) {
    const response = await owner
      .post('/api/v1/provider/workspace-invitations')
      .set('x-workspace-id', this.w.id)
      .send({ email, commandId, requestedColorId })
      .expect(201);
    return {
      body: response.body as {
        id: string;
        revision: number;
        delivery: string;
        requestedColorId: MemberColor | null;
      },
    };
  }
  async stop() {
    await this.app?.close();
    await this.db.stop();
    for (const [key, value] of [
      ['INVITATION_RESEND_COOLDOWN_SECONDS', this.previous.resend],
      ['EMAIL_VERIFICATION_COOLDOWN_SECONDS', this.previous.verify],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
