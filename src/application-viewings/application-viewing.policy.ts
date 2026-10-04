import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationViewingStatus as Status } from '../generated/prisma/enums';
import type { ProposeViewingDto } from './dto/viewing-input.dto';
import type { ViewingAudience } from './application-viewing-access.service';

export const viewingInclude = {
  outcomes: { orderBy: { revision: 'asc' } },
  interest: true,
} satisfies Prisma.ApplicationViewingInclude;
export type ViewingRecord = Prisma.ApplicationViewingGetPayload<{
  include: typeof viewingInclude;
}>;
export type ViewingCapabilityState = Pick<
  ViewingRecord,
  'status' | 'startsAt' | 'endsAt'
> & {
  outcomes: { recordedAt: Date }[];
  interest: { id: string } | null;
};
export type ViewingNextAction =
  | 'APPLICANT_RESPOND_TO_VIEWING'
  | 'PROVIDER_RESPOND_TO_CHANGE_REQUEST'
  | 'PROVIDER_RECORD_VIEWING_OUTCOME'
  | 'APPLICANT_CONFIRM_POST_VIEWING_INTEREST'
  | 'PROVIDER_CLOSE_UNANSWERED_VIEWING'
  | 'NONE';
export const CORRECTION_WINDOW_MS = 24 * 60 * 60_000;

@Injectable()
export class ViewingClock {
  now(): Date {
    return new Date();
  }
}

@Injectable()
export class ApplicationViewingPolicy {
  schedule(dto: ProposeViewingDto, now: Date) {
    const startsAt = this.instant(dto.startsAt, dto.timeZone);
    const endsAt = this.instant(dto.endsAt, dto.timeZone);
    const duration = endsAt.getTime() - startsAt.getTime();
    if (startsAt <= now || duration < 5 * 60_000 || duration > 240 * 60_000)
      throw new BadRequestException(
        'Viewing must start in the future and last 5 to 240 minutes',
      );
    return {
      startsAt,
      endsAt,
      timeZone: dto.timeZone,
      providerNote: this.text(dto.providerNote),
    };
  }

  text(value?: string): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string')
      throw new BadRequestException('Expected plain text');
    const text = value.trim();
    if (
      !text ||
      text.length > 500 ||
      !/^(?![\s\S]*(?![\r\n\t])\p{Cc})[^<>]*$/u.test(text)
    )
      throw new BadRequestException('Expected 1 to 500 plain-text characters');
    return text;
  }

  instant(value: string, zone: string): Date {
    if (
      typeof zone !== 'string' ||
      !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/u.test(zone)
    )
      throw new BadRequestException('IANA timezone required');
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      )
    )
      throw new BadRequestException(
        'Explicit ISO timestamp with timezone required',
      );
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException('Invalid timestamp');
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new BadRequestException('Invalid IANA timezone');
    }
    if (!value.endsWith('Z')) {
      const parts = formatter.formatToParts(date);
      const part = (name: Intl.DateTimeFormatPartTypes) =>
        parts.find((item) => item.type === name)?.value;
      const local = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
      if (local !== value.slice(0, 19))
        throw new BadRequestException(
          'Timestamp offset does not match timezone',
        );
    } else if (date.toISOString().slice(0, 19) !== value.slice(0, 19))
      throw new BadRequestException('Invalid calendar date');
    return date;
  }

  unresolved(viewing: Pick<ViewingRecord, 'status'>): boolean {
    return (
      viewing.status === Status.PROPOSED || viewing.status === Status.ACCEPTED
    );
  }

  capabilities(
    viewing: ViewingCapabilityState,
    side: ViewingAudience,
    mutable: boolean,
    latest: boolean,
    now: Date,
  ) {
    const provider = side === 'provider';
    const future = now < viewing.startsAt;
    const live = mutable && latest;
    const canRespond =
      live &&
      !provider &&
      future &&
      (viewing.status === Status.PROPOSED ||
        viewing.status === Status.ACCEPTED);
    const first = viewing.outcomes[0];
    return {
      canAccept:
        live && !provider && future && viewing.status === Status.PROPOSED,
      canDecline: canRespond,
      canRequestAnotherTime: canRespond,
      canReschedule: live && provider && future && this.unresolved(viewing),
      canCancel: live && provider && this.unresolved(viewing),
      canMarkCompleted:
        live &&
        provider &&
        viewing.status === Status.ACCEPTED &&
        now >= viewing.endsAt,
      canMarkNoShow:
        live &&
        provider &&
        viewing.status === Status.ACCEPTED &&
        now >= viewing.endsAt,
      canCorrectOutcome:
        live &&
        provider &&
        first !== undefined &&
        viewing.outcomes.length === 1 &&
        !viewing.interest &&
        now.getTime() < first.recordedAt.getTime() + CORRECTION_WINDOW_MS,
      canSubmitInterest:
        mutable &&
        !provider &&
        viewing.status === Status.COMPLETED &&
        !viewing.interest,
    };
  }

  nextAction(
    viewing: Pick<ViewingRecord, 'status' | 'startsAt' | 'endsAt'> & {
      interest: { id: string } | null;
    },
    mutable: boolean,
    latest: boolean,
    now: Date,
  ): ViewingNextAction {
    if (!mutable) return 'NONE';
    if (latest && viewing.status === Status.PROPOSED && now < viewing.startsAt)
      return 'APPLICANT_RESPOND_TO_VIEWING';
    if (latest && viewing.status === Status.PROPOSED && now >= viewing.startsAt)
      return 'PROVIDER_CLOSE_UNANSWERED_VIEWING';
    if (latest && viewing.status === Status.CHANGE_REQUESTED)
      return 'PROVIDER_RESPOND_TO_CHANGE_REQUEST';
    if (latest && viewing.status === Status.ACCEPTED && now >= viewing.endsAt)
      return 'PROVIDER_RECORD_VIEWING_OUTCOME';
    if (viewing.status === Status.COMPLETED && !viewing.interest)
      return 'APPLICANT_CONFIRM_POST_VIEWING_INTEREST';
    return 'NONE';
  }
}
