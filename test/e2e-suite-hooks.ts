import { afterAll, jest } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { finalizeSharedE2ESuite } from './e2e-cleanup';
import { verifySharedE2EHarnessQuiescent } from './e2e-harness-leak-detection';

function skipSharedSuiteFinalizer(testPath: string): boolean {
  if (!testPath.endsWith('.e2e-spec.ts')) return true;
  if (testPath.includes('migration')) return true;
  if (testPath.endsWith('e2e-cleanup.e2e-spec.ts')) return true;
  if (testPath.endsWith('e2e-database-safety.e2e-spec.ts')) return true;
  if (testPath.endsWith('profile-prequalification.e2e-spec.ts')) return true;
  if (testPath.endsWith('listing-deposit-concurrency.e2e-spec.ts')) return true;
  if (testPath.endsWith('verification-workflow.e2e-spec.ts')) return true;
  if (testPath.endsWith('verification-decisions.e2e-spec.ts')) return true;
  if (testPath.endsWith('verification-requirements.e2e-spec.ts')) return true;
  if (testPath.endsWith('application-runtime.e2e-spec.ts')) return true;
  if (testPath.endsWith('application-runtime-api.e2e-spec.ts')) return true;
  if (testPath.endsWith('application-documents.e2e-spec.ts')) return true;
  if (testPath.endsWith('listing-assignment-http.e2e-spec.ts')) return true;
  if (testPath.endsWith('workspace-discovery.e2e-spec.ts')) return true;
  if (testPath.endsWith('outbox-foundation.e2e-spec.ts')) return true;
  if (testPath.endsWith('realtime-outbox.e2e-spec.ts')) return true;
  if (testPath.endsWith('realtime-security.e2e-spec.ts')) return true;
  if (testPath.endsWith('application-invalidation.e2e-spec.ts')) return true;
  if (testPath.endsWith('notifications.e2e-spec.ts')) return true;
  if (testPath.endsWith('viewing-expiry.e2e-spec.ts')) return true;
  return false;
}

afterAll(async () => {
  const testPath = expect.getState().testPath ?? '';
  if (skipSharedSuiteFinalizer(testPath)) return;
  if (
    !process.env['E2E_DATABASE_URL'] ||
    process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true'
  ) {
    return;
  }
  process.env['DATABASE_URL'] = process.env['E2E_DATABASE_URL'];
  const pool = new Pool({
    connectionString: process.env['E2E_DATABASE_URL'],
    max: 1,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await finalizeSharedE2ESuite(prisma);
    await verifySharedE2EHarnessQuiescent(prisma);
    jest.restoreAllMocks();
    jest.useRealTimers();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}, 120_000);
