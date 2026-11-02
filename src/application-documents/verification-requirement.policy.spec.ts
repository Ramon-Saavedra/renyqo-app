import { ApplicationDocumentType } from '../generated/prisma/enums';
import { requirementDefinition } from './verification-requirement.policy';
import { VerificationCommandReceiptService } from './verification-command-receipt.service';

describe('Verification requirement identity and command fingerprints', () => {
  it.each([
    'SCHUFA',
    'INCOME_PROOF',
    'IDENTITY_DOCUMENT',
    'LIABILITY_INSURANCE',
  ] as const)(
    'keeps predefined %s identity independent of display text',
    (type) => {
      expect(requirementDefinition({ type })).toEqual({
        customLabel: null,
        definitionKey: type,
      });
      expect(() =>
        requirementDefinition({ type, customLabel: 'Another subject' }),
      ).toThrow();
    },
  );
  it('normalizes OTHER definitions without using the label as subject identity', () => {
    const one = requirementDefinition({
      type: 'OTHER',
      customLabel: '  Bank   Statement ',
    });
    const two = requirementDefinition({
      type: 'OTHER',
      customLabel: 'bank statement',
    });
    expect(one.definitionKey).toBe(two.definitionKey);
    expect(one.customLabel).toBe('Bank Statement');
  });
  it.each(['', '<script>', 'x'.repeat(101), 'bad\u0000label'])(
    'rejects invalid custom definitions: %j',
    (customLabel) => {
      expect(() =>
        requirementDefinition({
          type: ApplicationDocumentType.OTHER,
          customLabel,
        }),
      ).toThrow();
    },
  );
  it('fingerprints operation, subject, definition and optimistic revision', () => {
    const receipts = new VerificationCommandReceiptService();
    const base = {
      operation: 'REQUEST',
      items: [{ subjectId: 'A', definitionKey: 'INCOME_PROOF' }],
    };
    expect(receipts.hash(base)).toBe(receipts.hash({ ...base }));
    expect(receipts.hash(base)).not.toBe(
      receipts.hash({
        ...base,
        items: [{ subjectId: 'B', definitionKey: 'INCOME_PROOF' }],
      }),
    );
    expect(
      receipts.hash({
        operation: 'CANCEL',
        requestId: 'A',
        expectedRevision: 1,
      }),
    ).not.toBe(
      receipts.hash({
        operation: 'CANCEL',
        requestId: 'A',
        expectedRevision: 2,
      }),
    );
  });
});
