import { unitSession } from '../../test/unit-workspace-authority';
import type { ApplicantListingAccess } from '../listings/applicant-listing-access';
import { ApplicationProcessQueryService } from './application-process-query.service';
import type { PrismaService } from '../prisma/prisma.service';

it('bounds the legacy applicant listing image relation to its cover or first image', async () => {
  const findMany = jest.fn().mockResolvedValue([{ id: 'application-id' }]);
  const findUniqueOrThrow = jest.fn().mockResolvedValue({});
  const applicantListings = {
    assertPrincipal: jest.fn(() => Promise.resolve()),
    readApplication: jest.fn(
      async (
        _authority,
        _applicationId,
        _admit,
        produce: (tx: {
          application: { findUniqueOrThrow: typeof findUniqueOrThrow };
        }) => Promise<unknown>,
      ) =>
        produce({
          application: { findUniqueOrThrow },
        }),
    ),
  } as unknown as ApplicantListingAccess;
  const query = new ApplicationProcessQueryService(
    { application: { findMany } } as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    applicantListings,
  );
  await query.findAllByApplicantWithListing(unitSession('applicant'));
  expect(findMany).toHaveBeenCalledWith({
    where: { applicantId: 'applicant' },
    select: { id: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  expect(findUniqueOrThrow).toHaveBeenCalledWith({
    where: { id: 'application-id', applicantId: 'applicant' },
    include: {
      listing: {
        select: {
          id: true,
          title: true,
          city: true,
          coldRent: true,
          images: {
            select: { secureUrl: true, isCover: true, position: true },
            orderBy: [{ isCover: 'desc' }, { position: 'asc' }, { id: 'asc' }],
            take: 1,
          },
        },
      },
    },
  });
});
