import { describe, expect, it } from '@jest/globals';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';
import {
  ApplicationAdmissionService,
  REAPPLICATION_COOLDOWN_MS,
  type ApplicationAdmissionHistory,
} from './application-admission.service';
import { ApplicationAdmissionResponseDto } from './dto/application-admission-response.dto';

const service = new ApplicationAdmissionService();
const rejectedAt = new Date('2026-03-01T12:00:00Z');
const expiry = new Date(rejectedAt.getTime() + REAPPLICATION_COOLDOWN_MS);
const row = (
  overrides: Partial<ApplicationAdmissionHistory> = {},
): ApplicationAdmissionHistory => ({
  id: 'attempt-1',
  listingId: 'listing-1',
  status: ApplicationStatus.REJECTED,
  publicReason: ApplicationRejectionReason.NOT_SELECTED,
  rejectedAt,
  createdAt: new Date('2026-02-01T12:00:00Z'),
  listingEvents: [{ occurredAt: rejectedAt }],
  ...overrides,
});
const evaluate = (
  history: ApplicationAdmissionHistory[],
  asOf = rejectedAt,
  eligible = true,
  status: ListingStatus = ListingStatus.PUBLISHED,
) => service.evaluate(history, status, eligible, asOf);

describe('Application admission', () => {
  it('allows a recovered eligibility rejection without reopening the old attempt', () => {
    const history = [
      row({
        publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
        listingEvents: [],
      }),
    ];
    const original = structuredClone(history);
    expect(evaluate(history)).toMatchObject({
      canSubmitApplication: true,
      hasApplicationHistory: true,
      currentApplicationId: null,
      reapplyAvailableAt: null,
    });
    expect(evaluate(history, rejectedAt, false).submissionBlockReason).toBe(
      'APPLICANT_NOT_ELIGIBLE',
    );
    expect(history).toEqual(original);
  });

  it.each([-1, 0, 1])(
    'uses the exact 720-hour boundary with offset %s milliseconds',
    (offset) => {
      const result = evaluate([row()], new Date(expiry.getTime() + offset));
      expect(result.canSubmitApplication).toBe(offset >= 0);
      expect(result.reapplyAvailableAt).toEqual(offset < 0 ? expiry : null);
      expect(expiry.getTime() - rejectedAt.getTime()).toBe(
        720 * 60 * 60 * 1000,
      );
    },
  );

  it('uses the event over a conflicting row timestamp', () => {
    expect(
      evaluate([row({ rejectedAt: new Date('2020-01-01') })])
        .reapplyAvailableAt,
    ).toEqual(expiry);
  });

  it('falls back to the real rejection timestamp when no event exists', () => {
    expect(evaluate([row({ listingEvents: [] })]).reapplyAvailableAt).toEqual(
      expiry,
    );
  });

  it('requires review when a provider rejection has no reliable timestamp', () => {
    expect(
      evaluate([row({ rejectedAt: null, listingEvents: [] })]),
    ).toMatchObject({
      canSubmitApplication: false,
      submissionBlockReason: 'APPLICATION_HISTORY_REQUIRES_REVIEW',
      reapplyAvailableAt: null,
    });
  });

  it.each([ApplicationStatus.WITHDRAWN, ApplicationStatus.REJECTED])(
    'retains provider cooldown after a newer %s attempt',
    (status) => {
      const newer = row({
        id: 'attempt-2',
        status,
        publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
        listingEvents: [],
        rejectedAt: null,
      });
      expect(evaluate([newer, row()]).submissionBlockReason).toBe(
        'APPLICATION_REAPPLICATION_COOLDOWN',
      );
    },
  );

  it('keeps cooldown after same-row restoration clears rejection fields', () => {
    expect(
      evaluate([
        row({
          status: ApplicationStatus.WITHDRAWN,
          publicReason: null,
          rejectedAt: null,
        }),
      ]).reapplyAvailableAt,
    ).toEqual(expiry);
  });

  it('a repeated rejection restarts cooldown across attempts', () => {
    const later = new Date(expiry.getTime() + 10);
    const newer = row({
      id: 'attempt-2',
      listingEvents: [{ occurredAt: later }],
      rejectedAt: later,
    });
    expect(evaluate([row(), newer], later).reapplyAvailableAt).toEqual(
      new Date(later.getTime() + REAPPLICATION_COOLDOWN_MS),
    );
  });

  it.each([ApplicationStatus.ACTIVE, ApplicationStatus.WAITING])(
    'recognizes %s as current',
    (status) => {
      expect(evaluate([row({ status })])).toMatchObject({
        canSubmitApplication: false,
        currentApplicationId: 'attempt-1',
        currentApplicationStatus: status,
        submissionBlockReason: 'CURRENT_APPLICATION_EXISTS',
      });
    },
  );

  it('accepted attempts remain blocking', () => {
    expect(
      evaluate([row({ status: ApplicationStatus.ACCEPTED })], expiry)
        .submissionBlockReason,
    ).toBe('APPLICATION_ACCEPTED');
  });

  it('withdrawn attempts without provider rejection permit submission', () => {
    expect(
      evaluate([
        row({
          status: ApplicationStatus.WITHDRAWN,
          publicReason: null,
          listingEvents: [],
          rejectedAt: null,
        }),
      ]).canSubmitApplication,
    ).toBe(true);
  });

  it('listing rental rejection stays blocking and starts no cooldown', () => {
    expect(
      evaluate([
        row({
          publicReason: ApplicationRejectionReason.LISTING_RENTED,
          listingEvents: [],
        }),
      ]),
    ).toMatchObject({
      submissionBlockReason: 'LISTING_RENTED',
      reapplyAvailableAt: null,
    });
  });

  it.each([
    ListingStatus.DRAFT,
    ListingStatus.PAUSED,
    ListingStatus.ARCHIVED,
    ListingStatus.RENTED,
  ])('does not submit to %s', (status) => {
    expect(evaluate([], expiry, true, status).submissionBlockReason).toBe(
      'LISTING_NOT_ACCEPTING_APPLICATIONS',
    );
  });

  it('DTO preserves permission independently of historical application state', () => {
    const dto = new ApplicationAdmissionResponseDto(evaluate([row()], expiry));
    expect(dto).toMatchObject({
      hasApplicationHistory: true,
      canSubmitApplication: true,
      currentApplicationId: null,
      submissionBlockReason: null,
    });
    expect(new ApplicationAdmissionResponseDto().submissionBlockReason).toBe(
      'AUTHENTICATION_REQUIRED',
    );
  });
});
