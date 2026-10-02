import { BadRequestException } from '@nestjs/common';
import {
  ApplicationViewingStatus as Status,
  ViewingOutcome,
} from '../generated/prisma/enums';
import {
  ApplicationViewingPolicy,
  CORRECTION_WINDOW_MS,
  type ViewingRecord,
} from './application-viewing.policy';

describe('ApplicationViewingPolicy', () => {
  const policy = new ApplicationViewingPolicy();
  const now = new Date('2027-01-01T10:00:00Z');
  function row(status: Status = Status.PROPOSED): ViewingRecord {
    return {
      id: 'viewing',
      applicationId: 'application',
      round: 1,
      status,
      startsAt: new Date('2027-01-01T11:00:00Z'),
      endsAt: new Date('2027-01-01T11:30:00Z'),
      timeZone: 'Europe/Berlin',
      providerNote: null,
      acceptedAt: null,
      declinedAt: null,
      changeRequestedAt: null,
      changeRequestMessage: null,
      cancelledAt: null,
      supersededAt: null,
      requestKey: 'key',
      requestHash: 'hash',
      createdAt: now,
      updatedAt: now,
      outcomes: [],
      interest: null,
    };
  }

  it.each([5, 240])('accepts a %i minute duration', (minutes) => {
    expect(
      policy
        .schedule(
          {
            requestKey: 'key',
            startsAt: '2027-01-01T11:00:00Z',
            endsAt: new Date(
              Date.parse('2027-01-01T11:00:00Z') + minutes * 60_000,
            ).toISOString(),
            timeZone: 'Europe/Berlin',
          },
          now,
        )
        .startsAt.toISOString(),
    ).toBe('2027-01-01T11:00:00.000Z');
  });

  it.each([0, 4, 241])('rejects invalid duration %i', (minutes) => {
    expect(() =>
      policy.schedule(
        {
          requestKey: 'key',
          startsAt: '2027-01-01T11:00:00Z',
          endsAt: new Date(
            Date.parse('2027-01-01T11:00:00Z') + minutes * 60_000,
          ).toISOString(),
          timeZone: 'Europe/Berlin',
        },
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects past and exact-now starts', () => {
    expect(() =>
      policy.schedule(
        {
          requestKey: 'key',
          startsAt: now.toISOString(),
          endsAt: '2027-01-01T11:30:00Z',
          timeZone: 'Europe/Berlin',
        },
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it('handles both Berlin DST fold offsets and rejects spring gaps and mismatches', () => {
    expect(
      policy
        .instant('2027-10-31T02:30:00+02:00', 'Europe/Berlin')
        .toISOString(),
    ).toBe('2027-10-31T00:30:00.000Z');
    expect(
      policy
        .instant('2027-10-31T02:30:00+01:00', 'Europe/Berlin')
        .toISOString(),
    ).toBe('2027-10-31T01:30:00.000Z');
    expect(() =>
      policy.instant('2027-03-28T02:30:00+01:00', 'Europe/Berlin'),
    ).toThrow(BadRequestException);
    expect(() =>
      policy.instant('2027-01-01T11:00:00+02:00', 'Europe/Berlin'),
    ).toThrow(BadRequestException);
  });

  it.each(['2027-02-30T10:00:00Z', '2027-01-01T10:00:00', 'invalid'])(
    'rejects invalid timestamp %s',
    (value) => {
      expect(() => policy.instant(value, 'Europe/Berlin')).toThrow(
        BadRequestException,
      );
    },
  );

  it.each(['Invalid/Zone', '+01:00', 'CET'])(
    'rejects non-IANA timezone %s',
    (value) => {
      expect(() => policy.instant(now.toISOString(), value)).toThrow(
        BadRequestException,
      );
    },
  );

  it('derives next actions including unanswered proposals and interest', () => {
    expect(policy.nextAction(row(), true, true, now)).toBe(
      'APPLICANT_RESPOND_TO_VIEWING',
    );
    expect(policy.nextAction(row(), true, true, row().startsAt)).toBe(
      'PROVIDER_CLOSE_UNANSWERED_VIEWING',
    );
    expect(
      policy.nextAction(row(Status.CHANGE_REQUESTED), true, true, now),
    ).toBe('PROVIDER_RESPOND_TO_CHANGE_REQUEST');
    expect(
      policy.nextAction(row(Status.ACCEPTED), true, true, row().endsAt),
    ).toBe('PROVIDER_RECORD_VIEWING_OUTCOME');
    expect(policy.nextAction(row(Status.COMPLETED), true, false, now)).toBe(
      'APPLICANT_CONFIRM_POST_VIEWING_INTEREST',
    );
    for (const status of Object.values(Status))
      expect(policy.nextAction(row(status), false, true, now)).toBe('NONE');
    for (const status of [
      Status.DECLINED,
      Status.CANCELLED,
      Status.NO_SHOW,
      Status.SUPERSEDED,
    ])
      expect(policy.nextAction(row(status), true, true, now)).toBe('NONE');
  });

  it('requires end time for outcomes and restricts applicant/provider capabilities', () => {
    const viewing = row(Status.ACCEPTED);
    expect(
      policy.capabilities(viewing, 'provider', true, true, viewing.startsAt)
        .canMarkCompleted,
    ).toBe(false);
    expect(
      policy.capabilities(viewing, 'provider', true, true, viewing.endsAt)
        .canMarkCompleted,
    ).toBe(true);
    expect(
      policy.capabilities(viewing, 'applicant', true, true, viewing.endsAt)
        .canMarkCompleted,
    ).toBe(false);
    expect(
      policy.capabilities(viewing, 'provider', false, true, viewing.endsAt)
        .canCancel,
    ).toBe(false);
    expect(
      policy.capabilities(viewing, 'applicant', true, false, now).canDecline,
    ).toBe(false);
  });

  it('allows one correction before cutoff and before interest', () => {
    const viewing = row(Status.COMPLETED);
    viewing.outcomes = [
      {
        id: 'outcome',
        viewingId: viewing.id,
        revision: 1,
        outcome: ViewingOutcome.COMPLETED,
        correctionReason: null,
        recordedAt: now,
      },
    ];
    expect(
      policy.capabilities(viewing, 'provider', true, true, now)
        .canCorrectOutcome,
    ).toBe(true);
    expect(
      policy.capabilities(
        viewing,
        'provider',
        true,
        true,
        new Date(now.getTime() + CORRECTION_WINDOW_MS),
      ).canCorrectOutcome,
    ).toBe(false);
    expect(
      policy.capabilities(viewing, 'provider', true, false, now)
        .canCorrectOutcome,
    ).toBe(false);
  });

  it('trims safe text and rejects markup/control characters', () => {
    expect(policy.text('  Ab 16 Uhr\nDanke  ')).toBe('Ab 16 Uhr\nDanke');
    for (const text of ['<script>', '\u0000', ' ', 'a'.repeat(501)])
      expect(() => policy.text(text)).toThrow(BadRequestException);
  });
});
