import { BadRequestException, Injectable } from '@nestjs/common';
import { ViewingProposalTiming } from '../generated/prisma/enums';
import { ApplicationViewingPolicy } from './application-viewing.policy';
import type { WorkflowScheduleDto } from './dto/workflow-command.dto';
import type { ViewingAudience } from './application-viewing-access.service';

export const VIEWING_RESPONSE_MS = 12 * 60 * 60_000;
export const VIEWING_NORMAL_LEAD_MS = 18 * 60 * 60_000;
export const VIEWING_CHANGE_CUTOFF_MS = 6 * 60 * 60_000;

@Injectable()
export class ViewingWorkflowCommandPolicy {
  constructor(private readonly dates: ApplicationViewingPolicy) {}

  canonicalSchedule(dto: WorkflowScheduleDto) {
    return {
      startsAt: this.dates.instant(dto.startsAt, dto.timeZone).toISOString(),
      endsAt: this.dates.instant(dto.endsAt, dto.timeZone).toISOString(),
      timeZone: dto.timeZone,
      message: this.dates.text(dto.message),
      shortNotice: dto.shortNotice ?? false,
    };
  }

  schedule(
    dto: WorkflowScheduleDto,
    side: ViewingAudience,
    now: Date,
    confirmedStartsAt?: Date,
  ) {
    const { startsAt, endsAt, timeZone } = this.dates.schedule(dto, now);
    const message = this.dates.text(dto.message);
    const deadline = new Date(
      Math.min(
        now.getTime() + VIEWING_RESPONSE_MS,
        startsAt.getTime(),
        confirmedStartsAt?.getTime() ?? Infinity,
      ),
    );
    if (deadline <= now)
      throw new BadRequestException('No valid response window remains');
    const shortened = deadline.getTime() < now.getTime() + VIEWING_RESPONSE_MS;
    if (
      side === 'provider' &&
      !dto.shortNotice &&
      (startsAt.getTime() < now.getTime() + VIEWING_NORMAL_LEAD_MS || shortened)
    )
      throw new BadRequestException({
        code: 'VIEWING_SHORT_NOTICE_REQUIRED',
        message:
          'Normal invitations require 18 hours of lead time and a full 12-hour response window',
      });
    return {
      startsAt,
      endsAt,
      timeZone,
      message,
      timing:
        dto.shortNotice || shortened
          ? ViewingProposalTiming.SHORT_NOTICE
          : ViewingProposalTiming.NORMAL,
      responseDeadlineAt: deadline,
    };
  }
}
