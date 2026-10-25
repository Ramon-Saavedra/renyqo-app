import { ApplicationProcessQueryService } from './application-process-query.service';
import type { PrismaService } from '../prisma/prisma.service';

it('bounds the legacy applicant listing image relation to its cover or first image', async () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const query = new ApplicationProcessQueryService(
    { application: { findMany } } as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
  );
  await query.findAllByApplicantWithListing('applicant');
  expect(findMany.mock.calls[0]).toMatchObject([
    {
      include: {
        listing: {
          select: {
            images: {
              select: { secureUrl: true, isCover: true, position: true },
              orderBy: [
                { isCover: 'desc' },
                { position: 'asc' },
                { id: 'asc' },
              ],
              take: 1,
            },
          },
        },
      },
    },
  ]);
});
