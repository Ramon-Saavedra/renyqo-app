import { createHash } from 'node:crypto';

import {
  CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Response } from 'express';

import { ApplicationActionThrottlerStorage } from '../application-action-throttler.storage';
import { PrismaService } from '../../prisma/prisma.service';

export const APPLICATION_ACTION_RATE_LIMIT = 4;
export const APPLICATION_ACTION_RATE_LIMIT_WINDOW_MS = 60_000;
const APPLICATION_ACTION_THROTTLER_NAME = 'applicationActions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class ApplicantApplicationActionThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(
    ApplicantApplicationActionThrottlerGuard.name,
  );

  constructor(
    private readonly storage: ApplicationActionThrottlerStorage,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Record<string, unknown>>();
    const response = http.getResponse<Response>();
    const tracker = await this.getTracker(request);
    const key = createHash('sha256')
      .update(`${APPLICATION_ACTION_THROTTLER_NAME}:${tracker}`)
      .digest('hex');
    const result = await this.storage.increment(
      key,
      APPLICATION_ACTION_RATE_LIMIT_WINDOW_MS,
      APPLICATION_ACTION_RATE_LIMIT,
      APPLICATION_ACTION_RATE_LIMIT_WINDOW_MS,
      APPLICATION_ACTION_THROTTLER_NAME,
    );

    if (result.isBlocked) {
      response.setHeader('Retry-After', result.timeToBlockExpire);
      this.logger.warn(
        `Application action rate limit exceeded key=${key} limit=${APPLICATION_ACTION_RATE_LIMIT} ttl=${APPLICATION_ACTION_RATE_LIMIT_WINDOW_MS}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'APPLICATION_ACTION_RATE_LIMITED',
          message: 'Too many application actions. Please try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    response.setHeader('X-RateLimit-Limit', APPLICATION_ACTION_RATE_LIMIT);
    response.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, APPLICATION_ACTION_RATE_LIMIT - result.totalHits),
    );
    response.setHeader('X-RateLimit-Reset', result.timeToExpire);
    return true;
  }

  private async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req['user'];
    if (!isRecord(user) || typeof user['id'] !== 'string') {
      throw new UnauthorizedException();
    }

    const params = req['params'];
    const routeId = isRecord(params) ? params['id'] : undefined;
    if (typeof routeId !== 'string') {
      throw new UnauthorizedException();
    }

    if (!isUUID(routeId, '4')) {
      return `applicant:${user['id']}:unresolved`;
    }

    if (req['method'] !== 'DELETE') {
      const listing = await this.prisma.listing.findUnique({
        where: { id: routeId },
        select: { id: true },
      });
      return listing
        ? `applicant:${user['id']}:listing:${listing.id}`
        : `applicant:${user['id']}:unresolved`;
    }

    const application = await this.prisma.application.findFirst({
      where: { id: routeId, applicantId: user['id'] },
      select: { listingId: true },
    });

    return application
      ? `applicant:${user['id']}:listing:${application.listingId}`
      : `applicant:${user['id']}:unresolved`;
  }
}
