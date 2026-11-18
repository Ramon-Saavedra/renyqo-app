import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
@Injectable()
export class SecurityLinkTrafficGuard implements CanActivate {
  private readonly buckets = new Map<
    string,
    { until: number; count: number }
  >();
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const now = Date.now();
    const actor: unknown = req.user;
    const actorId =
      actor &&
      typeof actor === 'object' &&
      'id' in actor &&
      typeof actor.id === 'string'
        ? actor.id
        : 'anonymous';
    const key = `${req.ip}:${actorId}:${req.path}`;
    if (this.buckets.size >= 10000)
      for (const [k, v] of this.buckets)
        if (v.until <= now) this.buckets.delete(k);
    const old = this.buckets.get(key);
    const bucket =
      old && old.until > now ? old : { until: now + 60000, count: 0 };
    if (bucket.count >= 30 || (!old && this.buckets.size >= 10000))
      throw new HttpException(
        { code: 'SECURITY_LINK_RATE_LIMITED', message: 'Too many requests' },
        429,
      );
    bucket.count++;
    this.buckets.set(key, bucket);
    return true;
  }
}
