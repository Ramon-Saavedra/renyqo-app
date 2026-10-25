import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingEventType,
  ListingEventSource,
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
  listingEvents: [
    { type: ListingEventType.REJECTED_BY_PROVIDER, occurredAt: rejectedAt },
  ],
  ...overrides,
});
const evaluate = (
  history: ApplicationAdmissionHistory[],
  asOf = rejectedAt,
  eligible = true,
  status: ListingStatus = ListingStatus.PUBLISHED,
) => service.evaluate(history, status, eligible, asOf);

describe('Application admission', () => {
  it('system post-viewing timeout permits eligible reapplication without inventing provider cooldown', () => {
    expect(
      evaluate([
        row({
          publicReason:
            ApplicationRejectionReason.POST_VIEWING_RESPONSE_EXPIRED,
          listingEvents: [],
        }),
      ]),
    ).toMatchObject({
      canSubmitApplication: true,
      submissionBlockReason: null,
      reapplyAvailableAt: null,
    });
  });
  it('loads the latest provider curation event separately for each attempt', async () => {
    const rows = [row(), row({ id: 'attempt-2' })];
    const findMany = jest
      .fn<
        (
          args: Prisma.ApplicationFindManyArgs,
        ) => Promise<ApplicationAdmissionHistory[]>
      >()
      .mockResolvedValue(rows);
    const tx = {
      application: { findMany },
    } as unknown as Prisma.TransactionClient;
    const history = await service.historyForListings(tx, 'applicant-1', [
      'listing-1',
    ]);
    expect(history.get('listing-1')).toEqual(rows);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicantId: 'applicant-1', listingId: { in: ['listing-1'] } },
        select: expect.objectContaining({
          listingEvents: {
            where: {
              type: {
                in: [
                  ListingEventType.REJECTED_BY_PROVIDER,
                  ListingEventType.RESTORED_BY_PROVIDER,
                ],
              },
              source: ListingEventSource.PROVIDER,
              reason: ApplicationRejectionReason.NOT_SELECTED,
            },
            select: { type: true, occurredAt: true },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        }),
      }),
    );
  });
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

  it('cancels cooldown after same-row restoration and withdrawal', () => {
    expect(
      evaluate([
        row({
          status: ApplicationStatus.WITHDRAWN,
          publicReason: null,
          rejectedAt: null,
          listingEvents: [
            {
              type: ListingEventType.RESTORED_BY_PROVIDER,
              occurredAt: new Date(rejectedAt.getTime() + 60_000),
            },
          ],
        }),
      ]).reapplyAvailableAt,
    ).toBeNull();
  });

  it('uses current eligibility after restoration and automatic rejection', () => {
    const history = [
      row({
        publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
        listingEvents: [
          {
            type: ListingEventType.RESTORED_BY_PROVIDER,
            occurredAt: rejectedAt,
          },
        ],
      }),
    ];
    expect(evaluate(history, rejectedAt, false)).toMatchObject({
      submissionBlockReason: 'APPLICANT_NOT_ELIGIBLE',
      reapplyAvailableAt: null,
    });
    expect(evaluate(history).canSubmitApplication).toBe(true);
  });

  it('does not revive cancelled cooldown through stale legacy rejection fields', () => {
    const restored = row({
      status: ApplicationStatus.WITHDRAWN,
      listingEvents: [
        { type: ListingEventType.RESTORED_BY_PROVIDER, occurredAt: rejectedAt },
      ],
    });
    expect(evaluate([restored])).toMatchObject({
      canSubmitApplication: true,
      reapplyAvailableAt: null,
    });
    expect(
      evaluate([row({ ...restored, status: ApplicationStatus.REJECTED })])
        .submissionBlockReason,
    ).toBe('APPLICATION_HISTORY_REQUIRES_REVIEW');
  });

  it('cancels only the restored attempt across multiple historical attempts', () => {
    const restored = row({
      id: 'attempt-2',
      status: ApplicationStatus.WITHDRAWN,
      publicReason: null,
      rejectedAt: null,
      listingEvents: [
        {
          type: ListingEventType.RESTORED_BY_PROVIDER,
          occurredAt: new Date(rejectedAt.getTime() + 60_000),
        },
      ],
    });
    expect(evaluate([restored, row()])).toMatchObject({
      submissionBlockReason: 'APPLICATION_REAPPLICATION_COOLDOWN',
      reapplyAvailableAt: expiry,
    });
    const newerWithdrawn = row({
      id: 'attempt-3',
      status: ApplicationStatus.WITHDRAWN,
      publicReason: null,
      rejectedAt: null,
      listingEvents: [],
    });
    expect(evaluate([newerWithdrawn, restored]).canSubmitApplication).toBe(
      true,
    );
  });

  it.each([ApplicationStatus.ACTIVE, ApplicationStatus.WAITING])(
    'blocks duplicates after restoration to %s without cooldown',
    (status) => {
      expect(
        evaluate([
          row({
            status,
            publicReason: null,
            rejectedAt: null,
            listingEvents: [
              {
                type: ListingEventType.RESTORED_BY_PROVIDER,
                occurredAt: rejectedAt,
              },
            ],
          }),
        ]),
      ).toMatchObject({
        submissionBlockReason: 'CURRENT_APPLICATION_EXISTS',
        reapplyAvailableAt: null,
      });
    },
  );

  it('a repeated rejection restarts cooldown across attempts', () => {
    const later = new Date(expiry.getTime() + 10);
    const newer = row({
      id: 'attempt-2',
      listingEvents: [
        { type: ListingEventType.REJECTED_BY_PROVIDER, occurredAt: later },
      ],
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
