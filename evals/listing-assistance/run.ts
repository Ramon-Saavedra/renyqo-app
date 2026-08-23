import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ListingAssistanceService } from '../../src/listing-assistance/listing-assistance.service';
import { isListingExtractionField } from '../../src/listing-assistance/listing-extraction.policy';
import { toBerlinIsoDate } from '../../src/listing-assistance/listing-source-normalizer';
import { OpenAiProvider } from '../../src/listing-assistance/providers/openai.provider';
import type {
  AiProvider,
  ListingExtractionCandidate,
} from '../../src/listing-assistance/providers/ai-provider.interface';
import type { ListingAssistanceFile } from '../../src/listing-assistance/listing-assistance-upload.constants';

type EvalInputType = 'text' | 'transcript';

type EvalCase = {
  id: string;
  inputType: EvalInputType;
  input: string;
  expected: {
    values: Record<string, unknown>;
    depositEvidence: number | null;
    conflictingFields: string[];
    uncertainFields: string[];
  };
};

type OpenAiConfigKey =
  | 'OPENAI_API_KEY'
  | 'OPENAI_LISTING_MODEL'
  | 'OPENAI_TRANSCRIPTION_MODEL';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return (
    fields.every((field) => field in value) &&
    Object.keys(value).every((field) => fields.includes(field))
  );
}

function isEvalCase(value: unknown): value is EvalCase {
  if (!isRecord(value) || !isRecord(value.expected)) return false;
  return (
    hasOnlyFields(value, ['id', 'inputType', 'input', 'expected']) &&
    hasOnlyFields(value.expected, [
      'values',
      'depositEvidence',
      'conflictingFields',
      'uncertainFields',
    ]) &&
    typeof value.id === 'string' &&
    (value.inputType === 'text' || value.inputType === 'transcript') &&
    typeof value.input === 'string' &&
    isRecord(value.expected.values) &&
    Object.keys(value.expected.values).every(isListingExtractionField) &&
    (typeof value.expected.depositEvidence === 'number' ||
      value.expected.depositEvidence === null) &&
    isStringArray(value.expected.conflictingFields) &&
    new Set(value.expected.conflictingFields).size ===
      value.expected.conflictingFields.length &&
    value.expected.conflictingFields.every(isListingExtractionField) &&
    isStringArray(value.expected.uncertainFields) &&
    new Set(value.expected.uncertainFields).size ===
      value.expected.uncertainFields.length &&
    value.expected.uncertainFields.every(isListingExtractionField)
  );
}

class CapturingAiProvider implements AiProvider {
  lastCandidate: ListingExtractionCandidate | undefined;

  constructor(private readonly delegate: OpenAiProvider) {}

  async extractFromText(
    text: string,
    currentDate: Date,
  ): Promise<ListingExtractionCandidate> {
    const candidate = await this.delegate.extractFromText(text, currentDate);
    this.lastCandidate = candidate;
    return candidate;
  }

  extractFromPdf(
    file: ListingAssistanceFile,
    currentDate: Date,
  ): Promise<ListingExtractionCandidate> {
    return this.delegate.extractFromPdf(file, currentDate);
  }

  transcribeAudio(file: ListingAssistanceFile): Promise<string> {
    return this.delegate.transcribeAudio(file);
  }
}

async function readCases(): Promise<EvalCase[]> {
  const path = resolve('evals/listing-assistance/v1/cases.json');
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every(isEvalCase)) {
    throw new Error('Listing assistance eval cases are invalid.');
  }
  return parsed;
}

function getConfigValue(key: OpenAiConfigKey): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required to run Listing AI evals.`);
  return value;
}

function expectedValue(value: unknown, now: Date): unknown {
  return value === 'TODAY_BERLIN' ? toBerlinIsoDate(now) : value;
}

async function run(): Promise<void> {
  const now = new Date();
  const provider = new OpenAiProvider({ getOrThrow: getConfigValue });
  const capturingProvider = new CapturingAiProvider(provider);
  const service = new ListingAssistanceService(capturingProvider);
  const cases = await readCases();
  const failures: string[] = [];

  for (const evalCase of cases) {
    try {
      const response = await service.extractFromText(evalCase.input, now);
      const values = Object.fromEntries(Object.entries(response.values));
      const expectedValues: Record<string, unknown> = {};
      for (const [field, expected] of Object.entries(
        evalCase.expected.values,
      )) {
        const resolved = expectedValue(expected, now);
        if (resolved !== null) expectedValues[field] = resolved;
      }
      assert.deepEqual(values, expectedValues, 'values differ');
      assert.deepEqual(
        capturingProvider.lastCandidate?.depositEvidence,
        evalCase.expected.depositEvidence,
        'depositEvidence differs',
      );

      const conflictingFields = response.inconsistencies
        .filter(
          (issue) =>
            issue.message ===
            'The source contains conflicting values for this field',
        )
        .map((issue) => issue.field)
        .filter(isListingExtractionField)
        .sort();
      const uncertainFields = response.warnings
        .map((warning) =>
          warning.replace('The source contains an uncertain value for ', ''),
        )
        .filter(isListingExtractionField)
        .sort();

      assert.deepEqual(
        conflictingFields,
        [...evalCase.expected.conflictingFields].sort(),
        'conflictingFields differ',
      );
      assert.deepEqual(
        uncertainFields,
        [...evalCase.expected.uncertainFields].sort(),
        'uncertainFields differ',
      );
      process.stdout.write(`PASS ${evalCase.id} (${evalCase.inputType})\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      failures.push(`${evalCase.id}: ${message}`);
      process.stderr.write(`FAIL ${evalCase.id}: ${message}\n`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} Listing AI eval(s) failed.`);
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
