import {
  CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { normalizeIranMobile } from './phone';

export interface RateLimitOptions {
  /** Maximum requests allowed per key within the window. */
  limit: number;
  windowMs: number;
  /** Also limit by the Iranian mobile number in the `phone` body field. */
  byPhone?: boolean;
  phoneLimit?: number;
}

export const RATE_LIMIT_KEY = 'openbridge:rate-limit';
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window, in-memory limiter for HTTP endpoints. It is per-process, which
 * is sufficient for the current single-instance deployment; a shared store is
 * required before scaling horizontally.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private buckets = new Map<string, Bucket>();

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const route = `${request.method}:${request.route?.path ?? request.path}`;
    const ip = clientIp(request);
    const now = Date.now();

    const checks: Array<{ key: string; limit: number }> = [
      { key: `${route}:ip:${ip}`, limit: options.limit },
    ];
    if (options.byPhone) {
      const phone = typeof request.body?.phone === 'string'
        ? normalizeIranMobile(request.body.phone)
        : null;
      if (phone) {
        checks.push({
          key: `${route}:phone:${phone}`,
          limit: options.phoneLimit ?? options.limit,
        });
      }
    }

    // Check every bucket before counting so a rejected request never consumes
    // quota from a bucket that still had room.
    let retryAfterMs = 0;
    for (const { key, limit } of checks) {
      const bucket = this.buckets.get(key);
      if (bucket && bucket.resetAt <= now) this.buckets.delete(key);
      const active = this.buckets.get(key);
      if (active && active.count >= limit) {
        retryAfterMs = Math.max(retryAfterMs, active.resetAt - now);
      }
    }

    if (retryAfterMs > 0) {
      response.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'تلاش‌های بیش از حد؛ لطفاً بعداً دوباره تلاش کنید' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    for (const { key } of checks) {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.count += 1;
      else this.buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    }
    this.prune(now);
    return true;
  }

  private prune(now: number) {
    if (this.buckets.size < 5_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export function clientIp(request: Request): string {
  const ip = request.ip || request.socket?.remoteAddress || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
