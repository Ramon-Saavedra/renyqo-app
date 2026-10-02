import type {
  ApplicationViewingStatus,
  ViewingInterest,
  ViewingOutcome,
} from '../../generated/prisma/enums';
import type { ViewingNextAction } from '../application-viewing.policy';

export class ViewingCapabilitiesDto {
  canAccept = false;
  canDecline = false;
  canRequestAnotherTime = false;
  canReschedule = false;
  canCancel = false;
  canMarkCompleted = false;
  canMarkNoShow = false;
  canCorrectOutcome = false;
  canSubmitInterest = false;
}

export class ViewingOutcomeResponseDto {
  constructor(
    readonly revision: number,
    readonly outcome: ViewingOutcome,
    readonly correctionReason: string | null,
    readonly recordedAt: Date,
  ) {}
}

export class ViewingInterestResponseDto {
  constructor(
    readonly interest: ViewingInterest,
    readonly respondedAt: Date,
  ) {}
}

export class ViewingResponseDto extends ViewingCapabilitiesDto {
  constructor(
    readonly viewingId: string,
    readonly applicationId: string,
    readonly round: number,
    readonly status: ApplicationViewingStatus,
    readonly startsAt: Date,
    readonly endsAt: Date,
    readonly timeZone: string,
    readonly providerNote: string | null,
    readonly acceptedAt: Date | null,
    readonly declinedAt: Date | null,
    readonly changeRequestedAt: Date | null,
    readonly changeRequestMessage: string | null,
    readonly cancelledAt: Date | null,
    readonly supersededAt: Date | null,
    readonly proposedAt: Date,
    readonly updatedAt: Date,
    readonly outcomes: ViewingOutcomeResponseDto[],
    readonly interest: ViewingInterestResponseDto | null,
    readonly nextAction: ViewingNextAction,
    readonly isOverdue: boolean,
    readonly mutationsBlockedReason: 'APPLICATION_PROCESS_INACTIVE' | null,
  ) {
    super();
  }
}

export class ViewingPageResponseDto {
  constructor(
    readonly applicationId: string,
    readonly latestViewing: ViewingResponseDto | null,
    readonly currentViewing: ViewingResponseDto | null,
    readonly latestCompletedViewing: ViewingResponseDto | null,
    readonly pendingInterestViewing: ViewingResponseDto | null,
    readonly changeRequestedViewing: ViewingResponseDto | null,
    readonly history: ViewingResponseDto[],
    readonly hasMore: boolean,
    readonly nextBeforeRound: number | null,
    readonly canPropose: boolean,
    readonly nextAction: ViewingNextAction,
  ) {}
}
