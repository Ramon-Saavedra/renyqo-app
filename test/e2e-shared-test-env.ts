import { getE2EDatabaseName } from './e2e-database-safety';

/** Restores cross-suite process env after realtime/verification harnesses mutate it. */
export function applyCanonicalSharedE2EProcessEnv(): void {
  const databaseUrl = process.env['E2E_DATABASE_URL'];
  if (!databaseUrl || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
    return;
  const e2eDatabaseName = getE2EDatabaseName(databaseUrl);
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    PORT: '3000',
    FRONTEND_URL: 'http://localhost:3001',
    OUTBOX_DISPATCH_ENABLED: 'false',
    REALTIME_ENABLED: 'false',
    VIEWING_EXPIRY_ENABLED: 'false',
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'] ?? 'e2e-openai-api-key',
    OPENAI_LISTING_MODEL:
      process.env['OPENAI_LISTING_MODEL'] ?? 'e2e-listing-model',
    OPENAI_TRANSCRIPTION_MODEL:
      process.env['OPENAI_TRANSCRIPTION_MODEL'] ?? 'e2e-transcription-model',
    AI_RATE_LIMIT_WINDOW_MS: process.env['AI_RATE_LIMIT_WINDOW_MS'] ?? '60000',
    AI_TEXT_RATE_LIMIT: process.env['AI_TEXT_RATE_LIMIT'] ?? '10',
    AI_PDF_RATE_LIMIT: process.env['AI_PDF_RATE_LIMIT'] ?? '3',
    AI_AUDIO_RATE_LIMIT: process.env['AI_AUDIO_RATE_LIMIT'] ?? '3',
  });
  if (
    getE2EDatabaseName(process.env['DATABASE_URL'] ?? '') !== e2eDatabaseName
  ) {
    throw new Error(
      'DATABASE_URL and E2E_DATABASE_URL must target the same E2E database.',
    );
  }
}
