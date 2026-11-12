import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';

jest.setTimeout(60000);
describe('Listing Prisma/PostgreSQL shape agreement', () => {
  const f = new ListingWorkspaceFixture();
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
  });
  afterAll(() => f.stop());
  it('keeps the canonical new models consistent with migration introspection', () => {
    const database = new URL(process.env['E2E_DATABASE_URL']!);
    database.searchParams.set('schema', f.schema);
    const diff = execFileSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: database.toString() },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    mkdirSync('.tmp', { recursive: true });
    writeFileSync('.tmp/listing-schema-drift.sql', diff);
    const statements = diff
      .split(';')
      .map((statement) => statement.replace(/--[^\n]*/g, '').trim())
      .filter(Boolean);
    const relevant = statements.filter(
      (statement) =>
        /\b(?:ALTER TABLE|DROP TABLE|CREATE TABLE|CREATE INDEX|DROP INDEX|ALTER INDEX)\b/.test(
          statement,
        ) &&
        /"(?:listings|listing_assignment_transitions|listing_transfer_requests|public_listing_projections|listing_tenant_routes)"/.test(
          statement,
        ),
    );
    expect(relevant).toEqual([]);
  });
});
