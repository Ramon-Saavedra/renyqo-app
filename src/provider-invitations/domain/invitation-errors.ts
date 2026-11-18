import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
export function invitationConflict(code: string): never {
  throw new ConflictException({ code, message: code });
}
export function invitationMissing(): never {
  throw new NotFoundException({
    code: 'INVITATION_UNAVAILABLE',
    message: 'Invitation unavailable',
  });
}
export function translateInvitationFailure(error: unknown): never {
  function find(value: unknown, depth = 0): string | undefined {
    if (!value || typeof value !== 'object' || depth > 7) return;
    const r = value as Record<string, unknown>;
    if (r.code === '23514' || r.originalCode === '23514') {
      const message =
        typeof r.message === 'string'
          ? r.message
          : typeof r.originalMessage === 'string'
            ? r.originalMessage
            : '';
      const constraint = typeof r.constraint === 'string' ? r.constraint : '';
      for (const code of [
        'INVITATION_UNAVAILABLE',
        'INVITATION_COMMAND_CONFLICT',
        'MEMBERSHIP_LIFECYCLE_CONFLICT',
        'WORKSPACE_OVER_LIMIT',
        'PLAN_UNAVAILABLE',
        'SEAT_LIMIT_REACHED',
      ])
        if (constraint === code || message === code) return code;
      if (
        message === 'Ownership revision changed' ||
        message === 'Invitation unavailable' ||
        message === 'Invitation expired'
      )
        return 'INVITATION_UNAVAILABLE';
    }
    for (const key of ['meta', 'cause', 'driverAdapterError']) {
      const found = find(r[key], depth + 1);
      if (found) return found;
    }
  }
  const code = find(error);
  if (code) invitationConflict(code);
  throw error;
}
export function invitationRateLimited(): never {
  throw new HttpException(
    { code: 'INVITATION_RATE_LIMITED', message: 'Try again later' },
    429,
  );
}
