import {
  flushProcessWarnings,
  pgClientQueryOverlapWarnings,
} from './e2e-environment';
import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import {
  VerificationWorkflowHarness,
  responseObject as body,
} from './verification-workflow-harness';
import { ApplicationDocumentActivityService } from '../src/application-documents/application-document-activity.service';

jest.setTimeout(30000);
const h = new VerificationWorkflowHarness();
const providerPath = (id: string) => `/api/v1/provider/applications/${id}`;
const applicantPath = (id: string) => `/api/v1/applicant/applications/${id}`;
const requestCommand = (type = 'SCHUFA') => ({
  operation: 'REQUEST',
  items: [{ type }],
});
type Receipt = {
  scopeRevision: number;
  requirements: {
    id: string;
    round: number;
    revision: number;
    state: string;
  }[];
};
function receipt(response: Parameters<typeof body>[0]): Receipt {
  return body(response) as unknown as Receipt;
}
function items(
  response: Parameters<typeof body>[0],
): Record<string, unknown>[] {
  return body(response)['items'] as Record<string, unknown>[];
}
async function command(
  id: string,
  payload: object,
  status = 200,
  key: string = randomUUID(),
) {
  return h.send(
    h.provider,
    'post',
    `${providerPath(id)}/verification-commands`,
    payload,
    status,
    key,
  );
}
async function member(
  id: string,
  label: string,
  key: string = randomUUID(),
  status = 200,
) {
  return h.send(
    h.provider,
    'put',
    `${providerPath(id)}/verification-subjects/household-members/${key}`,
    { displayLabel: label },
    status,
  );
}

describe('Phase 3 verification workflow HTTP (isolated PostgreSQL)', () => {
  beforeAll(() => h.start(), 60000);
  afterAll(async () => {
    await h.stop();
    await flushProcessWarnings();
    expect(pgClientQueryOverlapWarnings()).toEqual([]);
  });

  it('creates any number of household subjects and requests the same type independently', async () => {
    const f = await h.fixture(),
      id = f.application.id,
      key = randomUUID();
    const first = body(await member(id, ' Member   A ', key));
    expect(body(await member(id, 'Member A', key))).toEqual(first);
    await member(id, 'Changed identity', key, 409);
    const second = body(await member(id, 'Member B'));
    const third = body(await member(id, 'Member C'));
    const result = receipt(
      await command(id, {
        operation: 'REQUEST',
        items: [
          { type: 'INCOME_PROOF' },
          ...[first, second, third].map((s) => ({
            type: 'INCOME_PROOF',
            subjectId: s['id'],
          })),
        ],
      }),
    );
    expect(result.scopeRevision).toBe(1);
    expect(result.requirements).toHaveLength(4);
    const list = await h.provider.agent
      .get(`${providerPath(id)}/verification-subjects?limit=2`)
      .expect(200);
    expect(body(list)['totalCount']).toBe(4);
    expect(body(list)['scopeRevision']).toBe(1);
    expect(items(list)).toHaveLength(2);
    const provider = await h.provider.agent
      .get(`${providerPath(id)}/verification-requirements`)
      .expect(200);
    const applicant = await h.applicant.agent
      .get(`${applicantPath(id)}/verification-requirements`)
      .expect(200);
    for (const response of [provider, applicant]) {
      expect(
        new Set(items(response).map((r) => JSON.stringify(r['subject']))).size,
      ).toBe(4);
      expect(items(response).every((r) => r['lifecycleState'] === 'OPEN')).toBe(
        true,
      );
      expect(JSON.stringify(response.body)).not.toMatch(
        /storageKey|checksum|scanVerdict|createdByUserId|passwordHash|versionId/,
      );
    }
    expect(items(applicant)[0]['capabilities']).toMatchObject({
      canUpload: true,
      canCancel: false,
    });
    expect(items(provider)[0]['capabilities']).toMatchObject({
      canUpload: false,
      canCancel: true,
    });
    const workspace = body(
      await h.applicant.agent.get(`${applicantPath(id)}/workspace`).expect(200),
    );
    expect(JSON.stringify(workspace['documentsSummary'])).toContain(
      'HOUSEHOLD_MEMBER',
    );
  });

  it('replays the original result after later commands and freeze, with authorization before replay', async () => {
    const f = await h.fixture(),
      id = f.application.id,
      key = randomUUID();
    const payload = {
      operation: 'REQUEST',
      items: [{ type: 'SCHUFA' }, { type: 'INCOME_PROOF' }],
    };
    const first = receipt(await command(id, payload, 200, key));
    await command(id, {
      operation: 'CANCEL',
      requestId: first.requirements[0].id,
      expectedRevision: 1,
    });
    expect(
      receipt(
        await command(
          id,
          { ...payload, items: [...payload.items].reverse() },
          200,
          key,
        ),
      ),
    ).toEqual(first);
    await command(id, requestCommand(), 409, key);
    await command(
      id,
      {
        operation: 'CANCEL',
        requestId: first.requirements[1].id,
        expectedRevision: 1,
      },
      409,
      key,
    );
    await h.prisma.application.update({
      where: { id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });
    expect(receipt(await command(id, payload, 200, key))).toEqual(first);
    await command(id, requestCommand('IDENTITY_DOCUMENT'), 409);
    await h.send(
      h.foreignProvider,
      'post',
      `${providerPath(id)}/verification-commands`,
      payload,
      404,
      key,
    );
    expect(
      await h.prisma.verificationCommandReceipt.count({
        where: { applicationId: id },
      }),
    ).toBe(2);
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } }))
        .verificationScopeRevision,
    ).toBe(2);
  });

  it.each([
    { operation: 'REQUEST', items: [] },
    {
      operation: 'REQUEST',
      items: [{ type: 'INCOME_PROOF', subjectId: null }],
    },
    {
      operation: 'REQUEST',
      items: [{ type: 'INCOME_PROOF', subjectId: 'bad-id' }],
    },
    {
      operation: 'REQUEST',
      items: [{ type: 'INCOME_PROOF', actorUserId: randomUUID() }],
    },
    { operation: 'CANCEL', requestId: randomUUID() },
    { operation: 'REPLACE', requestId: randomUUID(), expectedRevision: 0 },
    {
      operation: 'CANCEL',
      requestId: randomUUID(),
      expectedRevision: 1,
      items: [],
    },
    {
      operation: 'REQUEST',
      items: [{ type: 'INCOME_PROOF' }],
      expectedRevision: 1,
    },
    { operation: 'VERIFIED', requestId: randomUUID(), expectedRevision: 1 },
  ])('rejects malformed HTTP commands atomically %#', async (payload) => {
    const f = await h.fixture();
    await command(f.application.id, payload, 400);
    expect(
      await h.prisma.applicationDocumentRequest.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
    expect(
      await h.prisma.verificationCommandReceipt.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
  });

  it('validates keys, revisions, duplicate identities and scoped subject selection', async () => {
    const f = await h.fixture(),
      other = await h.fixture(),
      id = f.application.id;
    await h.send(
      h.provider,
      'post',
      `${providerPath(id)}/verification-commands`,
      requestCommand(),
      400,
    );
    await command(id, requestCommand(), 400, 'bad key');
    const foreign = body(await member(other.application.id, 'Other subject'));
    await command(
      id,
      {
        operation: 'REQUEST',
        items: [{ type: 'SCHUFA', subjectId: foreign['id'] }],
      },
      404,
    );
    await command(
      id,
      { operation: 'REQUEST', items: [{ type: 'SCHUFA' }, { type: 'SCHUFA' }] },
      409,
    );
    const first = receipt(await command(id, requestCommand()));
    await command(id, requestCommand(), 409);
    await command(
      id,
      {
        operation: 'CANCEL',
        requestId: first.requirements[0].id,
        expectedRevision: 2,
      },
      409,
    );
    await command(
      id,
      { operation: 'CANCEL', requestId: randomUUID(), expectedRevision: 1 },
      404,
    );
    await command(
      id,
      {
        operation: 'REPLACE',
        requestId: first.requirements[0].id,
        expectedRevision: 1,
      },
      409,
    );
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } }))
        .verificationScopeRevision,
    ).toBe(1);
  });

  it('enforces role, owner, WAITING visibility, CSRF and subject immutability boundaries', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const server: unknown = h.app.getHttpServer();
    await request(server as Parameters<typeof request>[0])
      .get(`${providerPath(id)}/verification-requirements`)
      .expect(401);
    await h.applicant.agent
      .get(`${providerPath(id)}/verification-requirements`)
      .expect(404);
    await h.foreignProvider.agent
      .get(`${providerPath(id)}/verification-subjects`)
      .expect(404);
    await h.otherApplicant.agent
      .get(`${applicantPath(id)}/verification-requirements`)
      .expect(404);
    await h.send(
      h.applicant,
      'post',
      `${providerPath(id)}/verification-commands`,
      requestCommand(),
      404,
      randomUUID(),
    );
    await h.provider.agent
      .post(`${providerPath(id)}/verification-commands`)
      .set('Origin', 'http://localhost:3001')
      .send(requestCommand())
      .expect(403);
    await h.send(
      h.provider,
      'put',
      `${providerPath(id)}/verification-subjects/household-members/${randomUUID()}`,
      { displayLabel: '<script>' },
      400,
    );
    await h.prisma.application.update({
      where: { id },
      data: { status: 'WAITING' },
    });
    await h.provider.agent
      .get(`${providerPath(id)}/verification-requirements`)
      .expect(404);
    await member(id, 'Hidden subject', randomUUID(), 404);
    await command(id, requestCommand(), 404);
    expect(
      body(
        await h.applicant.agent
          .get(`${applicantPath(id)}/verification-requirements`)
          .expect(200),
      )['frozen'],
    ).toMatchObject({ isFrozen: true, reason: 'APPLICATION_NOT_ACTIVE' });
  });

  it('preserves upload, review, replacement and historical evidence access without changing scope for evidence', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const first = receipt(await command(id, requestCommand()));
    const requestId = first.requirements[0].id;
    const fileId = String(body(await h.upload(id, requestId))['id']);
    let response = await h.applicant.agent
      .get(`${applicantPath(id)}/verification-requirements`)
      .expect(200);
    expect(items(response)[0]).toMatchObject({
      lifecycleState: 'OPEN',
      evidence: { fileState: 'PROCESSING', status: 'PROCESSING' },
    });
    await h.finalize(fileId);
    await h.send(
      h.provider,
      'post',
      `${providerPath(id)}/documents/${fileId}/review`,
      { status: 'REVIEWED' },
      201,
    );
    response = await h.provider.agent
      .get(`${providerPath(id)}/verification-requirements`)
      .expect(200);
    expect(body(response)['scopeRevision']).toBe(1);
    expect(items(response)[0]).toMatchObject({
      lifecycleState: 'OPEN',
      evidence: { fileState: 'AVAILABLE', status: 'REVIEWED' },
    });
    const before = await h.prisma.applicationDocumentFile.findUniqueOrThrow({
      where: { id: fileId },
    });
    const replaced = receipt(
      await command(id, {
        operation: 'REPLACE',
        requestId,
        expectedRevision: 1,
      }),
    );
    expect(replaced.scopeRevision).toBe(2);
    expect(replaced.requirements).toHaveLength(2);
    const next = replaced.requirements[1].id;
    const all = await h.provider.agent
      .get(`${providerPath(id)}/verification-requirements?lifecycleState=ALL`)
      .expect(200);
    expect(items(all)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: requestId,
          lifecycleState: 'SUPERSEDED',
          successorId: next,
        }),
        expect.objectContaining({
          id: next,
          predecessorId: requestId,
          round: 2,
        }),
      ]),
    );
    await h.upload(id, requestId, 404);
    await h.applicant.agent
      .get(`${applicantPath(id)}/documents/${fileId}/content`)
      .expect(200);
    expect(
      await h.prisma.applicationDocumentFile.findUniqueOrThrow({
        where: { id: fileId },
      }),
    ).toEqual(before);
  });

  it('cancels processing attempts without publication and links a later re-request round', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const first = receipt(await command(id, requestCommand()));
    const requestId = first.requirements[0].id;
    const fileId = String(body(await h.upload(id, requestId))['id']);
    await command(id, { operation: 'CANCEL', requestId, expectedRevision: 1 });
    await h.finalize(fileId);
    expect(
      await h.prisma.applicationDocumentFile.findUniqueOrThrow({
        where: { id: fileId },
      }),
    ).toMatchObject({ state: 'FAILED', availableAt: null });
    expect(
      items(
        await h.applicant.agent
          .get(`${applicantPath(id)}/verification-requirements`)
          .expect(200),
      ),
    ).toEqual([]);
    const next = receipt(await command(id, requestCommand()));
    expect(next.requirements[0].round).toBe(2);
    const page = items(
      await h.provider.agent
        .get(`${providerPath(id)}/verification-requirements?lifecycleState=ALL`)
        .expect(200),
    );
    expect(
      page.find((r) => r['id'] === requestId)?.['capabilities'],
    ).toMatchObject({ canReRequest: false });
  });

  it('preserves legacy array/mutation contracts and enriches safe history with the same identity', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const created = await h.send(
      h.provider,
      'post',
      `${providerPath(id)}/document-requests`,
      { requests: [{ type: 'SCHUFA' }] },
      201,
    );
    const rows = created.body as {
      id: string;
      status: string;
      verification: { subject: { kind: string } };
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'UPLOAD_REQUIRED',
      verification: { lifecycleState: 'OPEN', subject: { kind: 'APPLICANT' } },
    });
    const cancelled = body(
      await h.send(
        h.provider,
        'patch',
        `${providerPath(id)}/document-requests/${rows[0].id}/cancel`,
        {},
      ),
    );
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      supersededAt: null,
    });
    expect(typeof cancelled['closedAt']).toBe('string');
    const history = items(
      await h.applicant.agent
        .get(`${applicantPath(id)}/document-history`)
        .expect(200),
    );
    expect(history[0]['verification']).toMatchObject({
      lifecycleState: 'CANCELLED',
      revision: 2,
    });
    expect(
      await h.prisma.verificationCommandReceipt.count({
        where: { applicationId: id },
      }),
    ).toBe(0);
  });

  it('paginates subjects and requirement history deterministically with bounded safe projections', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const members = await Promise.all(
      Array.from({ length: 6 }, (_, i) => member(id, `Member ${i}`)),
    );
    await command(id, {
      operation: 'REQUEST',
      items: members.map((r) => ({
        type: 'INCOME_PROOF',
        subjectId: body(r)['id'],
      })),
    });
    for (const route of [
      'verification-subjects',
      'verification-requirements',
    ]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const response: Response = await h.provider.agent
          .get(
            `${providerPath(id)}/${route}?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          )
          .expect(200);
        expect(body(response)['totalCount']).toBe(6);
        const page = items(response);
        expect(page.length).toBeLessThanOrEqual(2);
        seen.push(...page.map((r) => String(r['id'])));
        cursor = (body(response)['pagination'] as { nextCursor: string | null })
          .nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
    }
    await h.provider.agent
      .get(`${providerPath(id)}/verification-requirements?cursor=invalid`)
      .expect(400);
    await h.provider.agent
      .get(`${providerPath(id)}/verification-requirements?limit=101`)
      .expect(400);
    await h.applicant.agent
      .get(`${applicantPath(id)}/verification-requirements?lifecycleState=ALL`)
      .expect(400);
  });

  it('freezes accepted and competing applications after rental while retaining OPEN history and replay', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const competitor = await h.prisma.application.create({
      data: {
        listingId: f.listing.id,
        applicantId: h.otherApplicant.id,
        status: 'ACTIVE',
        activeAt: new Date(),
      },
    });
    const key = randomUUID(),
      payload = requestCommand();
    const original = receipt(await command(id, payload, 200, key));
    const memberKey = randomUUID();
    await member(id, 'Frozen member', memberKey);
    await command(competitor.id, requestCommand());
    await h.applicant.agent.get(`/api/v1/listings/${f.listing.id}`).expect(200);
    await h.send(
      h.provider,
      'patch',
      `/api/v1/provider/listings/${f.listing.id}/rent`,
      { selectedApplicationId: id },
    );
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('ACCEPTED');
    expect(
      (
        await h.prisma.application.findUniqueOrThrow({
          where: { id: competitor.id },
        })
      ).status,
    ).toBe('REJECTED');
    for (const target of [id, competitor.id]) {
      const response = await h.provider.agent
        .get(`${providerPath(target)}/verification-requirements`)
        .expect(200);
      expect(body(response)['frozen']).toEqual({
        isFrozen: true,
        reason: 'LISTING_RENTED',
      });
      expect(items(response)[0]).toMatchObject({
        lifecycleState: 'OPEN',
        capabilities: { canCancel: false },
      });
      await command(target, requestCommand('INCOME_PROOF'), 409);
    }
    await member(id, 'Frozen member', memberKey, 409);
    expect(receipt(await command(id, payload, 200, key))).toEqual(original);
    await h.upload(id, original.requirements[0].id, 409);
    await h.applicant.agent.get(`/api/v1/listings/${f.listing.id}`).expect(404);
    const feed = body(
      await h.applicant.agent.get('/api/v1/listings').expect(200),
    );
    expect(
      (feed['items'] as { id: string }[]).some(
        (row) => row.id === f.listing.id,
      ),
    ).toBe(false);
  });

  it('resumes OPEN requirements after legitimate restoration and allows work while PAUSED', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const first = receipt(await command(id, requestCommand()));
    // A historical provider rejection is the precondition for the real restore API.
    await h.prisma.application.update({
      where: { id },
      data: {
        status: 'REJECTED',
        publicReason: 'NOT_SELECTED',
        rejectedAt: new Date(Date.now() - 120000),
      },
    });
    await member(id, 'Frozen', randomUUID(), 409);
    await h.send(h.provider, 'patch', `${providerPath(id)}/restore`, {});
    const response = await h.applicant.agent
      .get(`${applicantPath(id)}/verification-requirements`)
      .expect(200);
    expect(body(response)['frozen']).toEqual({ isFrozen: false, reason: null });
    expect(items(response)[0]).toMatchObject({
      id: first.requirements[0].id,
      capabilities: { canUpload: true },
    });
    await h.send(
      h.provider,
      'patch',
      `/api/v1/provider/listings/${f.listing.id}/pause`,
      {},
    );
    await member(id, 'Allowed during pause');
    await command(id, requestCommand('INCOME_PROOF'));
  });

  it('rolls back failed HTTP commands and serializes concurrent retries and replacement', async () => {
    const f = await h.fixture(),
      id = f.application.id,
      key = randomUUID();
    const spy = jest
      .spyOn(h.app.get(ApplicationDocumentActivityService), 'append')
      .mockRejectedValueOnce(new Error('phase3 injected persistence failure'));
    try {
      await command(id, requestCommand(), 500, key);
    } finally {
      spy.mockRestore();
    }
    expect(
      await h.prisma.verificationCommandReceipt.count({
        where: { applicationId: id },
      }),
    ).toBe(0);
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } }))
        .verificationScopeRevision,
    ).toBe(0);
    const results = await Promise.all(
      Array.from({ length: 3 }, () => command(id, requestCommand(), 200, key)),
    );
    for (const response of results)
      expect(receipt(response)).toEqual(receipt(results[0]));
    const requestId = receipt(results[0]).requirements[0].id;
    const fileId = String(body(await h.upload(id, requestId))['id']);
    await h.finalize(fileId);
    const headers = await h.headers(h.provider);
    const races = await Promise.all(
      Array.from({ length: 2 }, () =>
        h.provider.agent
          .post(`${providerPath(id)}/verification-commands`)
          .set(headers)
          .set('Idempotency-Key', randomUUID())
          .send({ operation: 'REPLACE', requestId, expectedRevision: 1 }),
      ),
    );
    expect(races.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await h.prisma.applicationDocumentRequest.count({
        where: { predecessorId: requestId },
      }),
    ).toBe(1);
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } }))
        .verificationScopeRevision,
    ).toBe(2);
  });

  it('serializes rental closure against a new requirement through the shared listing lock', async () => {
    const f = await h.fixture(),
      id = f.application.id;
    const headers = await h.headers(h.provider);
    const [created, rented] = await Promise.all([
      h.provider.agent
        .post(`${providerPath(id)}/verification-commands`)
        .set(headers)
        .set('Idempotency-Key', randomUUID())
        .send(requestCommand()),
      h.provider.agent
        .patch(`/api/v1/provider/listings/${f.listing.id}/rent`)
        .set(headers)
        .send({ selectedApplicationId: id }),
    ]);
    expect(rented.status).toBe(200);
    expect([200, 409]).toContain(created.status);
    const rows = await h.prisma.applicationDocumentRequest.findMany({
      where: { applicationId: id },
    });
    expect(rows).toHaveLength(created.status === 200 ? 1 : 0);
    expect(rows.every((row) => row.lifecycleState === 'OPEN')).toBe(true);
    expect(
      body(
        await h.provider.agent
          .get(`${providerPath(id)}/verification-requirements`)
          .expect(200),
      )['frozen'],
    ).toMatchObject({ isFrozen: true });
  });
});
