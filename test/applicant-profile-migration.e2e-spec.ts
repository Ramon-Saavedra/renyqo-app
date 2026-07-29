import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';

import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

const { Pool } = pg;

const MIGRATION_PATH = resolve(
  process.cwd(),
  'prisma/migrations/20260729202915_enforce_applicant_household_counts/migration.sql',
);

let pool: pg.Pool;

const SEED_USER_IDS = [
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000203',
  '00000000-0000-4000-8000-000000000204',
  '00000000-0000-4000-8000-000000000205',
  '00000000-0000-4000-8000-000000000206',
  '00000000-0000-4000-8000-000000000207',
];

const SEED_PROFILE_IDS = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
  '00000000-0000-4000-8000-000000000105',
  '00000000-0000-4000-8000-000000000107',
];

beforeAll(() => {
  const databaseUrl = process.env['E2E_DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('E2E_DATABASE_URL is required for migration E2E tests.');
  }

  assertSafeE2EDatabaseUrl(databaseUrl);

  pool = new Pool({ connectionString: databaseUrl });
});

afterAll(async () => {
  await pool?.end();
});

async function seedTestData(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const userId of SEED_USER_IDS) {
      await client.query(
        `INSERT INTO "users" ("id", "name", "email", "password_hash", "role", "status", "created_at", "updated_at")
         VALUES ($1, 'Test', 'test_' || $1 || '@test.local', '$2b$10$placeholderhash', 'applicant', 'active', NOW(), NOW())
         ON CONFLICT ("id") DO NOTHING`,
        [userId],
      );
    }

    for (const profileId of SEED_PROFILE_IDS) {
      await client.query(`DELETE FROM "applicant_profiles" WHERE "id" = $1`, [
        profileId,
      ]);
    }

    await client.query(`
      INSERT INTO "applicant_profiles" ("id", "applicant_id", "adults_count", "children_count", "people_count", "created_at", "updated_at")
      VALUES
        ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201', 2, 1, 3, NOW(), NOW()),
        ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000202', 1, 0, 1, NOW(), NOW()),
        ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000203', 2, 0, 0, NOW(), NOW()),
        ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000204', 1, NULL, 1, NOW(), NOW()),
        ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000205', 2, 1, NULL, NOW(), NOW()),
        ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000207', 2, NULL, NULL, NOW(), NOW())
    `);
  } finally {
    client.release();
  }
}

async function runMigration(): Promise<void> {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');
  const client = await pool.connect();
  try {
    await client.query(
      `ALTER TABLE "applicant_profiles" DROP CONSTRAINT IF EXISTS "applicant_profiles_household_counts_check"`,
    );
    await client.query(sql);
  } finally {
    client.release();
  }
}

async function cleanupTestData(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const profileId of [
      ...SEED_PROFILE_IDS,
      '00000000-0000-4000-8000-000000000106',
    ]) {
      await client.query(`DELETE FROM "applicant_profiles" WHERE "id" = $1`, [
        profileId,
      ]);
    }

    for (const userId of SEED_USER_IDS) {
      await client.query(`DELETE FROM "users" WHERE "id" = $1`, [userId]);
    }
  } finally {
    client.release();
  }
}

async function getRows() {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: string;
      adults_count: number | null;
      children_count: number | null;
      people_count: number | null;
    }>(
      `SELECT id, adults_count, children_count, people_count
       FROM "applicant_profiles"
       WHERE id IN ($1, $2, $3, $4, $5, $6)
       ORDER BY id`,
      SEED_PROFILE_IDS,
    );
    return result.rows;
  } finally {
    client.release();
  }
}

describe('Applicant household counts migration (E2E)', () => {
  beforeAll(async () => {
    await seedTestData();
    await runMigration();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it('preserves valid rows with matching counts', async () => {
    const rows = await getRows();
    const row = rows.find(
      (r) => r.id === '00000000-0000-4000-8000-000000000101',
    );
    expect(row?.adults_count).toBe(2);
    expect(row?.children_count).toBe(1);
    expect(row?.people_count).toBe(3);
  });

  it('preserves valid rows that were already correct', async () => {
    const rows = await getRows();
    const row = rows.find(
      (r) => r.id === '00000000-0000-4000-8000-000000000102',
    );
    expect(row?.adults_count).toBe(1);
    expect(row?.children_count).toBe(0);
    expect(row?.people_count).toBe(1);
  });

  it('recalculates inconsistent peopleCount', async () => {
    const rows = await getRows();
    const row = rows.find(
      (r) => r.id === '00000000-0000-4000-8000-000000000103',
    );
    expect(row?.adults_count).toBe(2);
    expect(row?.children_count).toBe(0);
    expect(row?.people_count).toBe(2);
  });

  it('clears counts where only peopleCount exists', async () => {
    const rows = await getRows();
    const row = rows.find(
      (r) => r.id === '00000000-0000-4000-8000-000000000104',
    );
    expect(row?.adults_count).toBeNull();
    expect(row?.children_count).toBeNull();
    expect(row?.people_count).toBeNull();
  });

  it('fills missing peopleCount from detailed counts', async () => {
    const rows = await getRows();
    const row = rows.find(
      (r) => r.id === '00000000-0000-4000-8000-000000000105',
    );
    expect(row?.adults_count).toBe(2);
    expect(row?.children_count).toBe(1);
    expect(row?.people_count).toBe(3);
  });

  it('clears orphaned partial household state', async () => {
    const rows = await getRows();
    const row = rows.find(
      (r) => r.id === '00000000-0000-4000-8000-000000000107',
    );
    expect(row?.adults_count).toBeNull();
    expect(row?.children_count).toBeNull();
    expect(row?.people_count).toBeNull();
  });

  it('rejects invalid household state via CHECK constraint', async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO "applicant_profiles" ("id", "applicant_id", "adults_count", "children_count", "people_count", "created_at", "updated_at")
         VALUES ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000206', 1, NULL, 1, NOW(), NOW())`,
      );
      throw new Error('Expected CHECK constraint violation');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/household_counts_check/);
    } finally {
      client.release();
    }
  });
});
