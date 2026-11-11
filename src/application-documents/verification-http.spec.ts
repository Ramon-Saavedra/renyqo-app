import { unitProvider } from '../../test/unit-workspace-authority';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  VerificationCommandDto,
  verificationCommand,
} from './dto/verification-input.dto';
import { VerificationCommandHttpService } from './verification-command-http.service';
import { VerificationRequirementService } from './verification-requirement.service';
import { VerificationDecisionService } from './verification-decision.service';
import { verificationFreeze } from './verification-projection';

const id = '00000000-0000-4000-8000-000000000001';

describe('Verification HTTP contracts', () => {
  it.each([
    { operation: 'REQUEST', items: [{ type: 'INCOME_PROOF', subjectId: id }] },
    { operation: 'CANCEL', requestId: id, expectedRevision: 1 },
    { operation: 'REPLACE', requestId: id, expectedRevision: 3 },
    {
      operation: 'DECIDE',
      requestId: id,
      expectedRevision: 1,
      evidenceFileId: null,
      expectedDecisionId: null,
      decision: 'WAIVED',
      reason: null,
    },
  ])('validates the $operation contract', async (input) => {
    const dto = plainToInstance(VerificationCommandDto, input);
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(verificationCommand(dto)).toEqual(input);
  });

  it.each([
    { operation: 'REQUEST', items: [] },
    {
      operation: 'REQUEST',
      items: [{ type: 'INCOME_PROOF', subjectId: null }],
    },
    {
      operation: 'REQUEST',
      items: [{ type: 'INCOME_PROOF', subjectId: 'foreign-text' }],
    },
    { operation: 'CANCEL', requestId: id },
    { operation: 'REPLACE', requestId: id, expectedRevision: 0 },
    { operation: 'WAIVED', requestId: id, expectedRevision: 1 },
    {
      operation: 'REQUEST',
      items: [{ type: 'INCOME_PROOF', definitionKey: 'client-controlled' }],
    },
  ])('rejects invalid command shape %#', async (input) => {
    expect(
      (
        await validate(plainToInstance(VerificationCommandDto, input), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects fields belonging to another operation', () => {
    expect(() =>
      verificationCommand(
        plainToInstance(VerificationCommandDto, {
          operation: 'REQUEST',
          items: [{ type: 'INCOME_PROOF' }],
          expectedRevision: 1,
        }),
      ),
    ).toThrow('REQUEST accepts only');
    expect(() =>
      verificationCommand(
        plainToInstance(VerificationCommandDto, {
          operation: 'CANCEL',
          requestId: id,
          expectedRevision: 1,
          items: [],
        }),
      ),
    ).toThrow('CANCEL, REPLACE and DECIDE require');
  });

  it('normalizes decision reasons and rejects contradictory ones', () => {
    const base = {
      operation: 'DECIDE',
      requestId: id,
      expectedRevision: 1,
      evidenceFileId: id,
      expectedDecisionId: null,
    };
    expect(
      verificationCommand(
        plainToInstance(VerificationCommandDto, {
          ...base,
          decision: 'NOT_SATISFIED',
          reason: '  income   mismatch  ',
        }),
      ),
    ).toMatchObject({ reason: 'income mismatch' });
    expect(() =>
      verificationCommand(
        plainToInstance(VerificationCommandDto, {
          ...base,
          decision: 'SATISFIED',
          reason: 'unnecessary',
        }),
      ),
    ).toThrow('SATISFIED does not accept a reason');
    expect(() =>
      verificationCommand(
        plainToInstance(VerificationCommandDto, {
          ...base,
          decision: 'NOT_SATISFIED',
        }),
      ),
    ).toThrow('NOT_SATISFIED requires a reason');
    expect(() =>
      verificationCommand(
        plainToInstance(VerificationCommandDto, {
          operation: 'CANCEL',
          requestId: id,
          expectedRevision: 1,
          decision: 'WAIVED',
        }),
      ),
    ).toThrow('Only DECIDE accepts');
  });

  it('routes DECIDE to the decision service', async () => {
    const result = {
      scopeRevision: 1,
      decision: {
        id,
        requestId: id,
        evidenceFileId: null,
        decision: 'WAIVED',
        decidedAt: '2026-11-05T00:00:00.000Z',
      },
      verification: { state: 'SATISFIED' },
    };
    const requirements = jest.fn();
    const decisions = jest.fn().mockResolvedValue(result);
    const service = new VerificationCommandHttpService(
      { execute: requirements } as unknown as VerificationRequirementService,
      { execute: decisions } as unknown as VerificationDecisionService,
    );
    const dto = plainToInstance(VerificationCommandDto, {
      operation: 'DECIDE',
      requestId: id,
      expectedRevision: 1,
      evidenceFileId: null,
      expectedDecisionId: null,
      decision: 'WAIVED',
    });
    expect(await service.execute(id, unitProvider(id), dto, 'decide-1')).toBe(
      result,
    );
    expect(decisions).toHaveBeenCalledWith(
      id,
      unitProvider(id),
      verificationCommand(dto),
      'decide-1',
    );
    expect(requirements).not.toHaveBeenCalled();
  });

  it('returns the domain receipt result directly', async () => {
    const result = { scopeRevision: 3, requirements: [] };
    const execute = jest.fn().mockResolvedValue(result);
    const service = new VerificationCommandHttpService(
      {
        execute,
      } as unknown as VerificationRequirementService,
      { execute: jest.fn() } as unknown as VerificationDecisionService,
    );
    const dto = plainToInstance(VerificationCommandDto, {
      operation: 'CANCEL',
      requestId: id,
      expectedRevision: 1,
    });
    expect(await service.execute(id, unitProvider(id), dto, 'retry-1')).toBe(
      result,
    );
    expect(execute).toHaveBeenCalledWith(
      id,
      unitProvider(id),
      verificationCommand(dto),
      'retry-1',
    );
    await expect(
      service.execute(id, unitProvider(id), dto, undefined),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.execute(id, unitProvider(id), dto, 'bad key'),
    ).rejects.toMatchObject({ status: 400 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('maps retry exhaustion to a retryable HTTP response while preserving business errors', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('Transaction could not be completed'));
    const service = new VerificationCommandHttpService(
      {
        execute,
      } as unknown as VerificationRequirementService,
      { execute: jest.fn() } as unknown as VerificationDecisionService,
    );
    const dto = plainToInstance(VerificationCommandDto, {
      operation: 'CANCEL',
      requestId: id,
      expectedRevision: 1,
    });
    await expect(
      service.execute(id, unitProvider(id), dto, 'retry'),
    ).rejects.toMatchObject({
      status: 503,
    });
    const failure = new Error('activity persistence failed');
    execute.mockRejectedValueOnce(failure);
    await expect(
      service.execute(id, unitProvider(id), dto, 'retry'),
    ).rejects.toBe(failure);
  });

  it.each([
    ['ACTIVE', 'PUBLISHED', false, null],
    ['ACTIVE', 'PAUSED', false, null],
    ['ACCEPTED', 'RENTED', true, 'LISTING_RENTED'],
    ['REJECTED', 'RENTED', true, 'LISTING_RENTED'],
    ['WITHDRAWN', 'PUBLISHED', true, 'APPLICATION_NOT_ACTIVE'],
    ['ACTIVE', 'RETIRED', true, 'LISTING_UNAVAILABLE'],
  ] as const)(
    'explains freeze for %s/%s',
    (status, listingStatus, isFrozen, reason) => {
      expect(
        verificationFreeze({ status, listing: { status: listingStatus } }),
      ).toEqual({ isFrozen, reason });
    },
  );
});
