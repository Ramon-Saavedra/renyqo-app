import { randomUUID } from 'node:crypto';
import { CapabilityFixture } from './provider-capabilities.fixture';
import type { ProviderCapability } from '../src/provider-authorization/capabilities/provider-capability';

const reads: ProviderCapability[] = [
  'LISTING_READ',
  'APPLICATION_READ',
  'DOCUMENT_READ',
  'VIEWING_READ',
  'CONVERSATION_READ',
];
jest.setTimeout(60000);
describe('Provider capabilities over HTTP through restricted runtime', () => {
  const f = new CapabilityFixture();
  let w: Awaited<ReturnType<CapabilityFixture['seed']>>;
  let client: Awaited<ReturnType<CapabilityFixture['login']>>;
  let index = 0;
  beforeAll(() => f.start(9));
  beforeEach(async () => {
    w = await f.seed(index++);
    client = await f.login(w.agents[0].userId);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.stop());
  const listing = (id: string) => `/api/v1/provider/listings/${id}`;
  const application = (id: string) => `/api/v1/provider/applications/${id}`;

  it('preserves AGENT assignment scope and OWNER workspace-wide visibility', async () => {
    await client
      .get(listing(w.listingId))
      .set('x-workspace-id', w.id)
      .expect(200);
    const other = await f.db.listing(w.id, w.owner, w.agents[1].id);
    await client.get(listing(other)).set('x-workspace-id', w.id).expect(404);
    const owner = await f.login(w.ownerUser);
    await owner.get(listing(other)).set('x-workspace-id', w.id).expect(200);
  });
  it('denies missing capability independently of ID existence and ignores client grants', async () => {
    f.restrictAgents([]);
    for (const id of [w.listingId, randomUUID()]) {
      await client
        .get(listing(id))
        .set('x-workspace-id', w.id)
        .set('x-provider-capabilities', 'LISTING_READ')
        .expect(403);
    }
  });
  it('collapses foreign and nonexistent applications to the same 404 contract', async () => {
    const foreign = await f.seed(0);
    const responses = [];
    for (const id of [foreign.applicationId, randomUUID()]) {
      const response = await client
        .get(`${application(id)}/workspace`)
        .set('x-workspace-id', w.id)
        .expect(404);
      responses.push(response.body as unknown);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]).toMatchObject({ message: 'Application not found' });
  });
  it('allows document metadata without granting document content', async () => {
    f.restrictAgents(['APPLICATION_READ', 'DOCUMENT_READ']);
    await client
      .get(`${application(w.applicationId)}/document-requests`)
      .set('x-workspace-id', w.id)
      .expect(200);
    await client
      .get(`/api/v1/provider/listings/${w.listingId}/exited-applications`)
      .set('x-workspace-id', w.id)
      .expect(200);
    await client
      .get(`${application(w.applicationId)}/documents/${randomUUID()}/content`)
      .set('x-workspace-id', w.id)
      .expect(403);
  });
  it('returns read-only composite action flags consistent with the actual commands', async () => {
    const path = application(w.applicationId);
    const before = await client
      .get(`${path}/workspace`)
      .set('x-workspace-id', w.id)
      .expect(200);
    expect(before.body).toMatchObject({
      documentsSummary: { canRequestDocuments: true },
      capabilities: { canReject: true },
    });
    f.restrictAgents(
      reads.filter((capability) => capability !== 'LISTING_READ'),
    );
    const response = await client
      .get(`${path}/workspace`)
      .set('x-workspace-id', w.id)
      .expect(200);
    expect(response.body).toMatchObject({
      capabilities: {
        canReject: false,
        canRestore: false,
        canSelectForRental: false,
      },
      documentsSummary: { canRequestDocuments: false },
      viewingSummary: { canPropose: false },
      conversationSummary: {
        canCurrentUserSend: false,
        canCurrentUserManageApplicantReplies: false,
      },
    });
    await client
      .patch(`${path}/reject`)
      .set('x-workspace-id', w.id)
      .expect(403);
    await client
      .post(`${path}/document-requests`)
      .set('x-workspace-id', w.id)
      .send({ requests: [{ type: 'SCHUFA' }] })
      .expect(403);
    await client
      .post(`${path}/conversation/messages`)
      .set('x-workspace-id', w.id)
      .send({ body: 'Denied message' })
      .expect(403);
  });
  it('rejects a composite missing one READ capability rather than returning partial sections', async () => {
    f.restrictAgents(
      reads.filter((capability) => capability !== 'DOCUMENT_READ'),
    );
    const response = await client
      .get(`${application(w.applicationId)}/workspace`)
      .set('x-workspace-id', w.id)
      .expect(403);
    expect(response.body).not.toHaveProperty('documentsSummary');
    await client
      .get('/api/v1/provider/attention')
      .set('x-workspace-id', w.id)
      .expect(403);
    await client
      .get('/api/v1/provider/listings/overview')
      .set('x-workspace-id', w.id)
      .expect(403);
  });
  it('requires a stable command independently of the creation capability', async () => {
    await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({})
      .expect(400);
  });

  it('cannot reject an application through viewing consideration without APPLICATION_MANAGE', async () => {
    f.restrictAgents([...reads, 'VIEWING_MANAGE']);
    await client
      .post(
        `${application(w.applicationId)}/viewing-workflow/appointments/${randomUUID()}/consideration`,
      )
      .set('x-workspace-id', w.id)
      .send({
        requestKey: randomUUID(),
        expectedWorkflowRevision: 0,
        consideration: 'DO_NOT_CONTINUE',
      })
      .expect(403);
    expect(
      (
        await f.db.prisma.application.findUniqueOrThrow({
          where: { id: w.applicationId },
        })
      ).status,
    ).toBe('ACTIVE');
  });
  it('reauthorizes a successful verification receipt before protected replay', async () => {
    const path = `${application(w.applicationId)}/verification-commands`;
    const body = { operation: 'REQUEST', items: [{ type: 'SCHUFA' }] };
    await client
      .post(path)
      .set('x-workspace-id', w.id)
      .set('Idempotency-Key', 'capability-replay')
      .send(body)
      .expect(200);
    f.restrictAgents(reads);
    await client
      .post(path)
      .set('x-workspace-id', w.id)
      .set('Idempotency-Key', 'capability-replay')
      .send(body)
      .expect(403);
    expect(
      await f.db.prisma.applicationDocumentRequest.count({
        where: { applicationId: w.applicationId },
      }),
    ).toBe(1);
  });
});
