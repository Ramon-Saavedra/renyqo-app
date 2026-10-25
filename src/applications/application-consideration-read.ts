import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

export const activeConsiderationOrder = [
  { considerationPosition: { position: 'asc' } },
  { id: 'asc' },
] satisfies Prisma.ApplicationOrderByWithRelationInput[];

type Facts = {
  position: bigint | null;
  revision: number | null;
  appointmentId: string | null;
  recordedAt: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
  timeZone: string | null;
};
export function considerationSummary(facts?: Facts) {
  return {
    position: facts?.position?.toString() ?? null,
    revision: facts?.revision ?? 0,
    applicantNoShow:
      facts?.appointmentId && facts.recordedAt
        ? {
            code: 'APPLICANT_NO_SHOW' as const,
            appointmentId: facts.appointmentId,
            recordedAt: facts.recordedAt,
            startsAt: facts.startsAt,
            endsAt: facts.endsAt,
            timeZone: facts.timeZone,
          }
        : null,
  };
}
export type ApplicationConsiderationSummary = ReturnType<
  typeof considerationSummary
>;

@Injectable()
export class ApplicationConsiderationReadService {
  async batch(
    tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
    applicationIds: readonly string[],
  ) {
    if (!applicationIds.length)
      return new Map<string, ApplicationConsiderationSummary>();
    // One bounded query, executed sequentially on the caller's read snapshot.
    const rows = await tx.$queryRaw<
      (Facts & { applicationId: string })[]
    >(Prisma.sql`
      SELECT a.id AS "applicationId", p.position, p.revision,
        absence.id AS "appointmentId", absence.recorded_at AS "recordedAt", absence.starts_at AS "startsAt", absence.ends_at AS "endsAt", absence.time_zone AS "timeZone"
      FROM applications a
      LEFT JOIN application_consideration_positions p ON p.application_id=a.id
      LEFT JOIN LATERAL (
        SELECT v.id, v.starts_at, v.ends_at, v.time_zone, effective.recorded_at FROM application_viewings v
        JOIN LATERAL (
          SELECT o.outcome,o.absence_side,o.recorded_at FROM application_viewing_outcomes o
          WHERE o.viewing_id=v.id ORDER BY o.revision DESC LIMIT 1
        ) effective ON effective.outcome='no_show' AND effective.absence_side='applicant'
        WHERE v.application_id=a.id AND v.status='no_show'
        ORDER BY v.round DESC LIMIT 1
      ) absence ON true
      WHERE a.id IN (${Prisma.join(applicationIds.map((id) => Prisma.sql`${id}::uuid`))})
    `);
    return new Map(
      rows.map((row) => [row.applicationId, considerationSummary(row)]),
    );
  }
}
