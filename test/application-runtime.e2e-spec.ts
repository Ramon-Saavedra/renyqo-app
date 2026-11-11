import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { assertApplicationRuntime } from '../src/provider-tenancy/application-runtime-verifier';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(30000);
describe('Operational application login cutover', () => {
  const f = new ListingWorkspaceFixture();
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
  });
  afterAll(() => f.stop());
  it('passes the production startup verifier through the actual separate application login', async () => {
    const prior = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await PrismaService.prototype.onModuleInit.call(f.applicationRuntime);
    } finally {
      if (prior === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = prior;
    }
    const row = (
      await f.applicationPool.query<{ current_user: string }>(
        'SELECT current_user',
      )
    ).rows[0];
    expect(row.current_user).toBe(f.applicationLogin);
  });
  it('rejects the migration login and the foundation-only login as application runtime', async () => {
    await expect(assertApplicationRuntime(f.prisma)).rejects.toThrow();
    await expect(assertApplicationRuntime(f.runtime)).rejects.toThrow();
  });
  it('boots a real production PrismaService constructor in the configured schema without pool overrides', async () => {
    const previousUrl = process.env['DATABASE_URL'],
      previousNode = process.env['NODE_ENV'];
    process.env['DATABASE_URL'] = f.applicationUrl;
    process.env['NODE_ENV'] = 'production';
    const service = new PrismaService();
    try {
      await service.onModuleInit();
      const [row] = await service.$queryRaw<
        { login: string; schema: string }[]
      >`SELECT current_user AS login,current_schema() AS schema`;
      expect(row).toEqual({ login: f.applicationLogin, schema: f.schema });
      expect(await service.publicListingProjection.count()).toBe(0);
    } finally {
      await service.$disconnect();
      if (previousUrl === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = previousUrl;
      if (previousNode === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNode;
    }
  });
  it.each([
    'renyqo_workspace_owner',
    'renyqo_workspace_invariants',
    'renyqo_applicant_listing_resolver',
    'renyqo_profile_revalidation',
  ])('cannot SET ROLE into %s', async (role) => {
    await expect(
      f.applicationPool.query(`SET ROLE ${role}`),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('cannot disable RLS, create schema objects, or truncate domain evidence', async () => {
    for (const sql of [
      'ALTER TABLE listings DISABLE ROW LEVEL SECURITY',
      'CREATE TABLE unsafe_runtime_ddl(id integer)',
      'TRUNCATE listing_assignment_transitions',
    ])
      await expect(f.applicationPool.query(sql)).rejects.toMatchObject({
        code: '42501',
      });
  });
});
