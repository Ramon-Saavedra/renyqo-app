import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { issueSecret } from '../src/security/opaque-secret';
jest.setTimeout(60000);
describe('Email verification identity proof', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('canonicalizes case and surrounding whitespace without provider-specific collapsing', async () => {
    const email = `Case.${randomUUID()}+Alias@invite.test`;
    const account = await f.account(` ${email} `);
    const row = await f.db.prisma.user.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(row.email).toBe(email.toLowerCase());
    await account.client
      .post('/api/v1/auth/login')
      .send({ email: email.toUpperCase(), password: 'StrongPass123' })
      .expect(200);
  });
  it('cannot use someone else’s proof and never persists the plaintext proof', async () => {
    const a = await f.account(),
      b = await f.account();
    await a.client
      .post('/api/v1/auth/email-verification/request')
      .send({})
      .expect(200);
    const token = f.secret(a.email, 'Verify');
    await b.client
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token })
      .expect(400);
    const proof = await f.db.prisma.emailVerificationChallenge.findFirstOrThrow(
      { where: { userId: a.id } },
    );
    expect(proof.tokenHash).not.toBe(token);
    expect(JSON.stringify(proof)).not.toContain(token);
    await a.client
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token })
      .expect(200);
  });
  it('invalidates verification and unused challenges when canonical email changes', async () => {
    const a = await f.account();
    await f.verify(a);
    await f.db.prisma.user.update({
      where: { id: a.id },
      data: { email: `${randomUUID()}@invite.test` },
    });
    expect(
      (await f.db.prisma.user.findUniqueOrThrow({ where: { id: a.id } }))
        .emailVerified,
    ).toBe(false);
    expect(
      await f.db.prisma.emailVerificationChallenge.count({
        where: { userId: a.id, usedAt: null },
      }),
    ).toBe(0);
  });
  it('rejects an expired proof without sleeps or changing the database clock', async () => {
    const a = await f.account();
    const { secret, hash } = issueSecret('email-verification');
    const grant = await f.db.prisma.sessionAuthGrant.findFirstOrThrow({
      where: { userId: a.id },
    });
    await f.db.prisma.emailVerificationChallenge.create({
      data: {
        id: randomUUID(),
        userId: a.id,
        email: a.email,
        tokenHash: hash,
        sessionId: grant.sid,
        authVersion: grant.authVersion,
        createdAt: new Date(0),
        expiresAt: new Date(1000),
      },
    });
    await a.client
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token: secret })
      .expect(400);
    expect(
      (await f.db.prisma.user.findUniqueOrThrow({ where: { id: a.id } }))
        .emailVerified,
    ).toBe(false);
  });
});
