import { randomUUID } from 'node:crypto';
import {
  flushProcessWarnings,
  pgClientQueryOverlapWarnings,
} from './e2e-environment';
import {
  VerificationWorkflowHarness,
  responseObject as body,
} from './verification-workflow-harness';

jest.setTimeout(30000);
const h = new VerificationWorkflowHarness();
const providerPath = (id: string) => `/api/v1/provider/applications/${id}`;
const applicantPath = (id: string) => `/api/v1/applicant/applications/${id}`;

type DecisionReceipt = {
  scopeRevision: number;
  decision: {
    id: string;
    requestId: string;
    evidenceFileId: string | null;
    decision: string;
    decidedAt: string;
  };
  verification: { state: string };
};

function receipt(response: { body: unknown }): DecisionReceipt {
  return body(response as never) as unknown as DecisionReceipt;
}
function state(response: { body: unknown }) {
  return (body(response as never)['verification'] as { state: string }).state;
}
async function command(
  id: string,
  payload: object,
  status = 200,
  key = randomUUID(),
  actor = h.provider,
) {
  return h.send(
    actor,
    'post',
    `${providerPath(id)}/verification-commands`,
    payload,
    status,
    key,
  );
}
async function requestOne(id: string, type = 'SCHUFA', subjectId?: string) {
  const response = await command(id, {
    operation: 'REQUEST',
    items: [{ type, ...(subjectId ? { subjectId } : {}) }],
  });
  const result = body(response) as unknown as {
    requirements: { id: string; revision: number }[];
  };
  return result.requirements[0];
}
async function publish(id: string, requestId: string) {
  const fileId = String(body(await h.upload(id, requestId))['id']);
  await h.finalize(fileId);
  return fileId;
}
function decide(
  requestId: string,
  decision: 'SATISFIED' | 'NOT_SATISFIED' | 'WAIVED',
  evidenceFileId: string | null = null,
  expectedDecisionId: string | null = null,
  reason?: string,
) {
  return {
    operation: 'DECIDE',
    requestId,
    expectedRevision: 1,
    evidenceFileId,
    expectedDecisionId,
    decision,
    ...(reason === undefined ? {} : { reason }),
  };
}
async function requirements(id: string, actor: 'provider' | 'applicant') {
  const agent = actor === 'provider' ? h.provider.agent : h.applicant.agent;
  const root = actor === 'provider' ? providerPath(id) : applicantPath(id);
  return body(await agent.get(`${root}/verification-requirements`).expect(200));
}

describe('Phase 4 verification decisions (isolated PostgreSQL)', () => {
  beforeAll(async () => {
    await h.start();
    expect(await h.prisma.verificationDecision.count()).toBe(0);
  }, 60000);
  afterAll(async () => {
    await h.stop();
    await flushProcessWarnings();
    expect(pgClientQueryOverlapWarnings()).toEqual([]);
  });

  it('keeps acknowledgement, waivers and corrections distinct from requirement lifecycle', async () => {
    const f = await h.fixture();
    const id = f.application.id;
    expect(
      state(
        await h.provider.agent
          .get(`${providerPath(id)}/verification-requirements`)
          .expect(200),
      ),
    ).toBe('NOT_REQUESTED');
    const requirement = await requestOne(id);
    expect(
      state(
        await h.provider.agent
          .get(`${providerPath(id)}/verification-requirements`)
          .expect(200),
      ),
    ).toBe('AWAITING_EVIDENCE');
    const processingId = String(body(await h.upload(id, requirement.id))['id']);
    expect((await requirements(id, 'applicant'))['verification']).toEqual({
      state: 'PROCESSING',
    });
    await h.finalize(processingId);
    expect((await requirements(id, 'provider'))['verification']).toEqual({
      state: 'AWAITING_DECISION',
    });
    await h.send(
      h.provider,
      'post',
      `${providerPath(id)}/documents/${processingId}/review`,
      { status: 'REVIEWED' },
      201,
    );
    const acknowledged = await requirements(id, 'provider');
    expect(acknowledged['verification']).toEqual({
      state: 'AWAITING_DECISION',
    });
    expect(acknowledged['items']).toEqual([
      expect.objectContaining({
        requirementState: 'AWAITING_DECISION',
        decision: null,
      }),
    ]);
    expect(
      await h.prisma.verificationDecision.count({
        where: { applicationId: id },
      }),
    ).toBe(0);

    await command(id, decide(requirement.id, 'SATISFIED'), 400);
    await command(id, decide(requirement.id, 'NOT_SATISFIED'), 400);
    await command(
      id,
      decide(requirement.id, 'NOT_SATISFIED', processingId),
      400,
    );
    const stale = decide(requirement.id, 'SATISFIED', processingId);
    await command(id, { ...stale, expectedRevision: 2 }, 409);
    const satisfied = receipt(await command(id, stale));
    expect(satisfied.scopeRevision).toBe(1);
    expect(satisfied.verification.state).toBe('SATISFIED');
    expect(satisfied.decision.evidenceFileId).toBe(processingId);
    const open = await h.prisma.applicationDocumentRequest.findUniqueOrThrow({
      where: { id: requirement.id },
    });
    expect(open.lifecycleState).toBe('OPEN');
    expect(open.revision).toBe(1);

    const reason = 'The income figures do not match the application';
    const corrected = receipt(
      await command(
        id,
        decide(
          requirement.id,
          'NOT_SATISFIED',
          processingId,
          satisfied.decision.id,
          reason,
        ),
      ),
    );
    expect(corrected.decision.id).not.toBe(satisfied.decision.id);
    expect(corrected.verification.state).toBe('NOT_SATISFIED');
    const rows = await h.prisma.verificationDecision.findMany({
      where: { requirementId: requirement.id },
      orderBy: { decidedAt: 'asc' },
    });
    expect(rows.map((row) => [row.outcome, row.previousDecisionId])).toEqual([
      ['SATISFIED', null],
      ['NOT_SATISFIED', satisfied.decision.id],
    ]);
    expect(rows[0].outcome).toBe('SATISFIED');
    const providerView = await requirements(id, 'provider');
    const applicantView = await requirements(id, 'applicant');
    const providerItems = providerView['items'];
    if (!Array.isArray(providerItems) || providerItems.length !== 1)
      throw new Error('Expected one provider requirement');
    const providerItem = providerItems[0] as Record<string, unknown>;
    const providerDecision = providerItem['decision'] as Record<
      string,
      unknown
    >;
    expect(providerItem['requirementState']).toBe('NOT_SATISFIED');
    expect(providerDecision).toMatchObject({
      id: corrected.decision.id,
      reason,
      actorUserId: h.provider.id,
      previousDecisionId: satisfied.decision.id,
    });
    expect(JSON.stringify(applicantView)).not.toContain(reason);
    expect(JSON.stringify(applicantView)).not.toContain(h.provider.id);
    expect(applicantView['items']).toEqual([
      expect.objectContaining({ requirementState: 'NOT_SATISFIED' }),
    ]);
    expect(JSON.stringify(applicantView['items'])).not.toContain('actorUserId');

    const replayKey = randomUUID();
    const first = receipt(
      await command(
        id,
        decide(
          requirement.id,
          'SATISFIED',
          processingId,
          corrected.decision.id,
        ),
        200,
        replayKey,
      ),
    );
    const second = receipt(
      await command(
        id,
        decide(
          requirement.id,
          'SATISFIED',
          processingId,
          corrected.decision.id,
        ),
        200,
        replayKey,
      ),
    );
    expect(second).toEqual(first);
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: requirement.id },
      }),
    ).toBe(3);
    await command(
      id,
      decide(
        requirement.id,
        'WAIVED',
        null,
        first.decision.id,
        'different command',
      ),
      409,
      replayKey,
    );
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: requirement.id },
      }),
    ).toBe(3);

    const income = await requestOne(id, 'INCOME_PROOF');
    expect((await requirements(id, 'applicant'))['verification']).toEqual({
      state: 'AWAITING_EVIDENCE',
    });
    const waived = receipt(
      await command(
        id,
        decide(income.id, 'WAIVED', null, null, 'no longer required'),
      ),
    );
    expect(waived.scopeRevision).toBe(2);
    expect(waived.verification.state).toBe('SATISFIED');
    expect((await requirements(id, 'applicant'))['items']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: income.id, requirementState: 'WAIVED' }),
        expect.objectContaining({
          id: requirement.id,
          requirementState: 'SATISFIED',
        }),
      ]),
    );
    const member = body(
      await h.send(
        h.provider,
        'put',
        `${providerPath(id)}/verification-subjects/household-members/${randomUUID()}`,
        { displayLabel: 'Member A' },
      ),
    );
    const memberRequirement = await requestOne(
      id,
      'LIABILITY_INSURANCE',
      String(member['id']),
    );
    expect((await requirements(id, 'provider'))['verification']).toEqual({
      state: 'AWAITING_EVIDENCE',
    });
    await command(id, decide(memberRequirement.id, 'WAIVED'));
    expect((await requirements(id, 'provider'))['verification']).toEqual({
      state: 'SATISFIED',
    });
  });

  it('ignores superseded and cancelled decisions and replaces a waived round without rewriting it', async () => {
    const f = await h.fixture();
    const id = f.application.id;
    const first = await requestOne(id);
    const second = await requestOne(id, 'INCOME_PROOF');
    await command(id, decide(second.id, 'WAIVED'));
    await command(id, {
      operation: 'CANCEL',
      requestId: second.id,
      expectedRevision: 1,
    });
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: second.id },
      }),
    ).toBe(1);
    expect((await requirements(id, 'provider'))['verification']).toEqual({
      state: 'AWAITING_EVIDENCE',
    });

    const fileId = await publish(id, first.id);
    const satisfied = receipt(
      await command(id, decide(first.id, 'SATISFIED', fileId)),
    );
    await command(id, {
      operation: 'REPLACE',
      requestId: first.id,
      expectedRevision: 1,
    });
    const rounds = await h.prisma.applicationDocumentRequest.findMany({
      where: { applicationId: id, definitionKey: 'SCHUFA' },
      orderBy: { round: 'asc' },
    });
    expect(rounds.map((row) => row.lifecycleState)).toEqual([
      'SUPERSEDED',
      'OPEN',
    ]);
    expect(
      await h.prisma.verificationDecision.findMany({
        where: { requirementId: first.id },
      }),
    ).toEqual([
      expect.objectContaining({
        id: satisfied.decision.id,
        outcome: 'SATISFIED',
      }),
    ]);
    expect((await requirements(id, 'provider'))['verification']).toEqual({
      state: 'AWAITING_EVIDENCE',
    });

    const waived = await requestOne(id, 'IDENTITY_DOCUMENT');
    await command(id, decide(waived.id, 'WAIVED'));
    await command(
      id,
      { operation: 'REPLACE', requestId: waived.id, expectedRevision: 1 },
      409,
    );
    const published = await publish(id, waived.id);
    await command(
      id,
      decide(
        waived.id,
        'WAIVED',
        published,
        (
          await h.prisma.verificationDecision.findFirstOrThrow({
            where: { requirementId: waived.id, next: { is: null } },
          })
        ).id,
      ),
    );
    await command(id, {
      operation: 'REPLACE',
      requestId: waived.id,
      expectedRevision: 1,
    });
    const identity = await h.prisma.applicationDocumentRequest.findMany({
      where: { applicationId: id, definitionKey: 'IDENTITY_DOCUMENT' },
      orderBy: { round: 'asc' },
    });
    expect(identity.map((row) => row.lifecycleState)).toEqual([
      'SUPERSEDED',
      'OPEN',
    ]);
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: identity[1].id },
      }),
    ).toBe(0);
  });

  it('resolves an application when every open requirement is waived', async () => {
    const f = await h.fixture();
    const id = f.application.id;
    const first = await requestOne(id);
    const created = body(
      await command(id, {
        operation: 'REQUEST',
        items: [{ type: 'OTHER', customLabel: 'Guarantor letter' }],
      }),
    ) as unknown as { requirements: { id: string }[] };
    await command(id, decide(first.id, 'WAIVED'));
    await command(id, decide(created.requirements[0].id, 'WAIVED'));
    const items = (await requirements(id, 'provider'))['items'] as {
      requirementState: string;
    }[];
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.requirementState === 'WAIVED')).toBe(
      true,
    );
    expect((await requirements(id, 'applicant'))['verification']).toEqual({
      state: 'SATISFIED',
    });
  });

  it('rejects applicant, foreign provider and hidden waiting applications', async () => {
    const f = await h.fixture();
    const id = f.application.id;
    const requirement = await requestOne(id);
    const payload = decide(requirement.id, 'WAIVED');
    await command(id, payload, 403, randomUUID(), h.applicant);
    await command(id, payload, 404, randomUUID(), h.foreignProvider);
    await h.prisma.application.update({
      where: { id },
      data: { status: 'WAITING', activeAt: null },
    });
    await command(id, payload, 404);
    expect(
      await h.prisma.verificationDecision.count({
        where: { applicationId: id },
      }),
    ).toBe(0);
  });

  it('freezes terminal and rented applications, then accepts a new decision after restoration', async () => {
    const f = await h.fixture();
    const id = f.application.id;
    const requirement = await requestOne(id);
    await h.send(
      h.provider,
      'patch',
      `/api/v1/provider/listings/${f.listing.id}/rent`,
      { selectedApplicationId: id },
    );
    await command(id, decide(requirement.id, 'WAIVED'), 409);
    expect(
      await h.prisma.verificationDecision.count({
        where: { applicationId: id },
      }),
    ).toBe(0);
    await h.prisma.listing.update({
      where: { id: f.listing.id },
      data: { status: 'PUBLISHED' },
    });
    await h.prisma.application.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
    const restored = receipt(
      await command(id, decide(requirement.id, 'WAIVED')),
    );
    expect(restored.verification.state).toBe('SATISFIED');

    await h.prisma.application.update({
      where: { id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });
    await command(
      id,
      decide(requirement.id, 'WAIVED', null, restored.decision.id),
      409,
    );
    await h.prisma.application.update({
      where: { id },
      data: { status: 'ACTIVE', withdrawnAt: null },
    });
    const corrected = receipt(
      await command(
        id,
        decide(
          requirement.id,
          'WAIVED',
          null,
          restored.decision.id,
          'still unnecessary',
        ),
      ),
    );
    const history = await h.prisma.verificationDecision.findMany({
      where: { requirementId: requirement.id },
      orderBy: { decidedAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(
      expect.objectContaining({
        id: restored.decision.id,
        outcome: 'WAIVED',
        reason: null,
      }),
    );
    expect(history[1].previousDecisionId).toBe(restored.decision.id);
    expect(corrected.scopeRevision).toBe(1);
  });

  it('serializes competing decisions, replacements and retries without duplicate rows', async () => {
    const f = await h.fixture();
    const id = f.application.id;
    const requirement = await requestOne(id);
    const fileId = await publish(id, requirement.id);
    const headers = await h.headers(h.provider);
    const post = (payload: object, key = randomUUID()) =>
      h.provider.agent
        .post(`${providerPath(id)}/verification-commands`)
        .set(headers)
        .set('Idempotency-Key', key)
        .send(payload);
    const satisfied = decide(requirement.id, 'SATISFIED', fileId);
    const first = await Promise.all([post(satisfied), post(satisfied)]);
    expect(first.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: requirement.id },
      }),
    ).toBe(1);
    const current = await h.prisma.verificationDecision.findFirstOrThrow({
      where: { requirementId: requirement.id },
    });
    const correction = decide(
      requirement.id,
      'NOT_SATISFIED',
      fileId,
      current.id,
      'does not prove the claim',
    );
    const corrections = await Promise.all([post(correction), post(correction)]);
    expect(corrections.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: requirement.id },
      }),
    ).toBe(2);

    const replaceTarget = await requestOne(id, 'INCOME_PROOF');
    const replaceFile = await publish(id, replaceTarget.id);
    const raced = await Promise.all([
      post(decide(replaceTarget.id, 'SATISFIED', replaceFile)),
      post({
        operation: 'REPLACE',
        requestId: replaceTarget.id,
        expectedRevision: 1,
      }),
    ]);
    expect(raced.map((response) => response.status)).toContain(200);
    expect(
      raced.every(
        (response) => response.status === 200 || response.status === 409,
      ),
    ).toBe(true);
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: replaceTarget.id },
      }),
    ).toBeLessThanOrEqual(1);
    expect(
      await h.prisma.applicationDocumentRequest.count({
        where: { predecessorId: replaceTarget.id },
      }),
    ).toBeLessThanOrEqual(1);

    const cancelTarget = await requestOne(id, 'IDENTITY_DOCUMENT');
    const cancelFile = await publish(id, cancelTarget.id);
    const cancelled = await Promise.all([
      post(
        decide(
          cancelTarget.id,
          'NOT_SATISFIED',
          cancelFile,
          null,
          'unreadable',
        ),
      ),
      post({
        operation: 'CANCEL',
        requestId: cancelTarget.id,
        expectedRevision: 1,
      }),
    ]);
    expect(cancelled.map((response) => response.status)).toContain(200);
    expect(
      cancelled.every(
        (response) => response.status === 200 || response.status === 409,
      ),
    ).toBe(true);
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: cancelTarget.id },
      }),
    ).toBeLessThanOrEqual(1);

    const retry = await requestOne(id, 'LIABILITY_INSURANCE');
    const retryFile = await publish(id, retry.id);
    const key = randomUUID();
    const payload = decide(retry.id, 'SATISFIED', retryFile);
    const retries = await Promise.all([post(payload, key), post(payload, key)]);
    expect(
      retries.every(
        (response) => response.status === 200 || response.status === 409,
      ),
    ).toBe(true);
    expect(retries.map((response) => response.status)).toContain(200);
    const stored = receipt(await command(id, payload, 200, key));
    expect(
      await h.prisma.verificationDecision.count({
        where: { requirementId: retry.id },
      }),
    ).toBe(1);
    expect(stored.decision.requestId).toBe(retry.id);
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } }))
        .verificationScopeRevision,
    ).toBeGreaterThan(0);
    const scope = (
      await h.prisma.application.findUniqueOrThrow({ where: { id } })
    ).verificationScopeRevision;
    expect(stored.scopeRevision).toBeLessThanOrEqual(scope);
  });

  it('decides a migrated open requirement while the application scope is still zero', async () => {
    const f = await h.fixture();
    const id = f.application.id;
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } }))
        .verificationScopeRevision,
    ).toBe(0);
    const subject = await h.prisma.applicationVerificationSubject.create({
      data: {
        applicationId: id,
        kind: 'APPLICANT',
        subjectKey: 'applicant',
        createdByUserId: h.provider.id,
      },
    });
    const requestId = randomUUID();
    await h.prisma.$executeRawUnsafe(
      'ALTER TABLE application_document_requests DISABLE TRIGGER requirement_write_guard',
    );
    try {
      await h.prisma.applicationDocumentRequest.create({
        data: {
          id: requestId,
          applicationId: id,
          subjectId: subject.id,
          type: 'SCHUFA',
          definitionKey: 'SCHUFA',
          round: 1,
          provenance: 'LEGACY',
          lifecycleState: 'OPEN',
          revision: 1,
        },
      });
    } finally {
      await h.prisma.$executeRawUnsafe(
        'ALTER TABLE application_document_requests ENABLE TRIGGER requirement_write_guard',
      );
    }
    const file = await h.prisma.applicationDocumentFile.create({
      data: {
        requestId,
        storageKey: randomUUID(),
        bucket: 'verification-http-e2e',
        checksum: 'a'.repeat(64),
        mimeType: 'application/pdf',
        size: 128,
        state: 'AVAILABLE',
        recoverAfter: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        availableAt: new Date(),
      },
    });
    await h.prisma.applicationDocumentRequest.update({
      where: { id: requestId },
      data: { currentFileId: file.id },
    });
    const key = randomUUID();
    const payload = decide(requestId, 'SATISFIED', file.id);
    const committed = receipt(await command(id, payload, 200, key));
    expect(committed.scopeRevision).toBe(0);
    expect(committed.verification.state).toBe('SATISFIED');
    expect(
      (await h.prisma.application.findUniqueOrThrow({ where: { id } }))
        .verificationScopeRevision,
    ).toBe(0);
    expect(
      await h.prisma.verificationDecision.findMany({
        where: { applicationId: id },
      }),
    ).toEqual([
      expect.objectContaining({
        id: committed.decision.id,
        scopeRevision: 0,
        outcome: 'SATISFIED',
        evidenceFileId: file.id,
      }),
    ]);
    expect(
      await h.prisma.verificationCommandReceipt.findMany({
        where: { applicationId: id },
      }),
    ).toEqual([
      expect.objectContaining({
        operation: 'DECIDE',
        scopeRevision: 0,
      }),
    ]);
    expect(receipt(await command(id, payload, 200, key))).toEqual(committed);
    expect(
      await h.prisma.verificationDecision.count({
        where: { applicationId: id },
      }),
    ).toBe(1);

    await h.prisma.$executeRawUnsafe(
      'ALTER TABLE verification_command_receipts DISABLE TRIGGER verification_receipt_result',
    );
    try {
      for (const operation of ['REQUEST', 'CANCEL', 'REPLACE'] as const) {
        await expect(
          h.prisma.$executeRawUnsafe(
            `INSERT INTO verification_command_receipts (
              id, application_id, actor_user_id, idempotency_key, operation,
              payload_hash, schema_version, scope_revision, result
            ) VALUES (
              gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::"VerificationCommandOperation",
              $5, 1, 0, $6::jsonb
            )`,
            id,
            h.provider.id,
            `scope-zero-${operation}`,
            operation,
            'a'.repeat(64),
            JSON.stringify({
              scopeRevision: 0,
              requirements: [
                {
                  id: requestId,
                  round: 1,
                  revision: 1,
                  state: 'OPEN',
                },
              ],
            }),
          ),
        ).rejects.toThrow(/verification_receipt_shape/);
      }
    } finally {
      await h.prisma.$executeRawUnsafe(
        'ALTER TABLE verification_command_receipts ENABLE TRIGGER verification_receipt_result',
      );
    }
  });
});
