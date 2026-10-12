import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';

process.env['OPENAI_API_KEY'] ??= 'e2e-openai-api-key';
process.env['OPENAI_LISTING_MODEL'] ??= 'e2e-listing-model';
process.env['OPENAI_TRANSCRIPTION_MODEL'] ??= 'e2e-transcription-model';
process.env['AI_RATE_LIMIT_WINDOW_MS'] ??= '60000';
process.env['AI_TEXT_RATE_LIMIT'] ??= '10';
process.env['AI_PDF_RATE_LIMIT'] ??= '3';
process.env['AI_AUDIO_RATE_LIMIT'] ??= '3';

const PG_CLIENT_QUERY_OVERLAP_LOG = join(
  tmpdir(),
  `renyqo-pg-client-query-overlap-${process.pid}.log`,
);

export function pgClientQueryOverlapWarnings(): string[] {
  try {
    return readFileSync(PG_CLIENT_QUERY_OVERLAP_LOG, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new Error(
        'pg client query overlap recorder is not installed; run E2E through npm run test:e2e',
      );
    }
    throw error;
  }
}

export function flushProcessWarnings(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
