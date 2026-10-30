import { Injectable } from '@nestjs/common';
import type { ApplicantProfile, Prisma } from '../generated/prisma/client';

@Injectable()
export class ApplicationTransactionService {
  async lockListing(
    tx: Prisma.TransactionClient,
    listingId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "listings" WHERE id = ${listingId} FOR UPDATE`;
  }

  async lockApplication(
    tx: Prisma.TransactionClient,
    applicationId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "applications" WHERE id = ${applicationId} FOR UPDATE`;
  }

  async lockApplicantProfile(
    tx: Prisma.TransactionClient,
    applicantId: string,
  ): Promise<ApplicantProfile | null> {
    await tx.$queryRaw`SELECT id FROM "applicant_profiles" WHERE applicant_id = ${applicantId} FOR UPDATE`;
    return tx.applicantProfile.findUnique({ where: { applicantId } });
  }

  async assignWaitingQueueOrder(
    tx: Prisma.TransactionClient,
    listingId: string,
    applicationId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      UPDATE "applications"
      SET "queue_order" = nextval(pg_get_serial_sequence('applications', 'queue_order'))
      WHERE "id" = ${applicationId}::uuid AND "listing_id" = ${listingId}::uuid
    `;
  }
}
