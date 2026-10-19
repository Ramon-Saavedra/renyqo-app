import { Prisma } from '../generated/prisma/client';
import type { ApplicantApplicationOverviewGroup } from './dto/applicant-application-overview-query.dto';

export function applicantRepresentativesCte(applicantId: string) {
  return Prisma.sql`
    representatives AS (
      SELECT DISTINCT ON (listing_id)
        id,
        created_at AS "createdAt",
        status::text AS status
      FROM applications
      WHERE applicant_id = ${applicantId}::uuid
      ORDER BY listing_id,
        CASE WHEN status IN ('active', 'waiting') THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
    )
  `;
}

export function applicantOverviewGroupFilter(
  group: ApplicantApplicationOverviewGroup,
) {
  switch (group) {
    case 'ACTIVE':
      return Prisma.sql`status = 'active'`;
    case 'WAITING':
      return Prisma.sql`status = 'waiting'`;
    case 'DONE':
      return Prisma.sql`status IN ('accepted', 'rejected', 'withdrawn')`;
    default:
      return Prisma.sql`TRUE`;
  }
}

export function applicantOverviewGroupCountKey(
  group: ApplicantApplicationOverviewGroup,
): 'all' | 'active' | 'waiting' | 'done' {
  switch (group) {
    case 'ACTIVE':
      return 'active';
    case 'WAITING':
      return 'waiting';
    case 'DONE':
      return 'done';
    default:
      return 'all';
  }
}
