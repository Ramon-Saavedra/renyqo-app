import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getProviderAiTracker(req: Record<string, unknown>): string {
  const user = req['user'];

  if (!isRecord(user) || typeof user['id'] !== 'string') {
    throw new UnauthorizedException();
  }

  return `provider:${user['id']}`;
}

@Injectable()
export class ProviderAiThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(getProviderAiTracker(req));
  }
}
