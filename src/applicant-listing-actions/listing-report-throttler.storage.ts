import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

type ListingReportBucket = {
  totalHits: number;
  expiresAt: number;
  blockedUntil: number;
  cleanupTimer?: NodeJS.Timeout;
};

type ListingReportRateLimitResult = {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
};

@Injectable()
export class ListingReportThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly buckets = new Map<string, ListingReportBucket>();

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ListingReportRateLimitResult> {
    void throttlerName;
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || (bucket.expiresAt <= now && bucket.blockedUntil <= now)) {
      if (bucket) {
        clearTimeout(bucket.cleanupTimer);
      }
      bucket = {
        totalHits: 0,
        expiresAt: now + ttl,
        blockedUntil: 0,
      };
      this.buckets.set(key, bucket);
    }

    if (bucket.blockedUntil <= now) {
      if (bucket.expiresAt <= now) {
        bucket.totalHits = 0;
        bucket.expiresAt = now + ttl;
      }
      bucket.totalHits++;
      if (bucket.totalHits > limit) {
        bucket.blockedUntil = now + blockDuration;
      }
    }

    this.scheduleCleanup(key, bucket);

    return Promise.resolve({
      totalHits: bucket.totalHits,
      timeToExpire: Math.max(0, Math.ceil((bucket.expiresAt - now) / 1000)),
      isBlocked: bucket.blockedUntil > now,
      timeToBlockExpire: Math.max(
        0,
        Math.ceil((bucket.blockedUntil - now) / 1000),
      ),
    });
  }

  onApplicationShutdown(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.cleanupTimer) {
        clearTimeout(bucket.cleanupTimer);
      }
    }
    this.buckets.clear();
  }

  private scheduleCleanup(key: string, bucket: ListingReportBucket): void {
    if (bucket.cleanupTimer) {
      clearTimeout(bucket.cleanupTimer);
    }
    const cleanupAt = Math.max(bucket.expiresAt, bucket.blockedUntil);
    bucket.cleanupTimer = setTimeout(
      () => {
        if (this.buckets.get(key) === bucket) {
          this.buckets.delete(key);
        }
      },
      Math.max(1, cleanupAt - Date.now() + 1),
    );
    bucket.cleanupTimer.unref();
  }
}
