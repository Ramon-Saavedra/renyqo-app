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
import type { Response } from 'express';

import { ListingReportThrottlerStorage } from '../listing-report-throttler.storage';

export const LISTING_REPORT_RATE_LIMIT = 5;
export const LISTING_REPORT_RATE_LIMIT_WINDOW_MS = 3_600_000;
const LISTING_REPORT_THROTTLER_NAME = 'listingReports';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class ListingReportThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(ListingReportThrottlerGuard.name);

  constructor(private readonly storage: ListingReportThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Record<string, unknown>>();
    const response = http.getResponse<Response>();
    const tracker = this.getTracker(request);
    const key = createHash('sha256')
      .update(`${LISTING_REPORT_THROTTLER_NAME}:${tracker}`)
      .digest('hex');
    const result = await this.storage.increment(
      key,
      LISTING_REPORT_RATE_LIMIT_WINDOW_MS,
      LISTING_REPORT_RATE_LIMIT,
      LISTING_REPORT_RATE_LIMIT_WINDOW_MS,
      LISTING_REPORT_THROTTLER_NAME,
    );

    if (result.isBlocked) {
      response.setHeader('Retry-After', result.timeToBlockExpire);
      this.logger.warn(
        `Listing report rate limit exceeded key=${key} limit=${LISTING_REPORT_RATE_LIMIT} ttl=${LISTING_REPORT_RATE_LIMIT_WINDOW_MS}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'LISTING_REPORT_RATE_LIMITED',
          message: 'Too many listing reports. Please try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    response.setHeader('X-RateLimit-Limit', LISTING_REPORT_RATE_LIMIT);
    response.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, LISTING_REPORT_RATE_LIMIT - result.totalHits),
    );
    response.setHeader('X-RateLimit-Reset', result.timeToExpire);
    return true;
  }

  private getTracker(req: Record<string, unknown>): string {
    const user = req['user'];
    if (!isRecord(user) || typeof user['id'] !== 'string') {
      throw new UnauthorizedException();
    }

    return `applicant:${user['id']}`;
  }
}
