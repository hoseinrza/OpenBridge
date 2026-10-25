import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAINTENANCE_INTERVAL_SECONDS,
  MAINTENANCE_SESSION_RETENTION_DAYS,
} from '../config/env';

const DAY_MS = 24 * 60 * 60 * 1000;

// Database housekeeping that has nothing to do with a request. It runs in the
// same process on purpose: for a single-instance Beta a @nestjs/schedule
// dependency and a distributed lock would be more moving parts than the work
// justifies. Every statement is idempotent, so a restart mid-run is harmless.
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(
      () => void this.runOnce(),
      MAINTENANCE_INTERVAL_SECONDS * 1000,
    );
    // Housekeeping must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // Exposed so a test can run one pass without waiting for the interval, and so
  // an operator can trigger it from a future admin path.
  async runOnce(now = new Date()) {
    if (this.running) return null;
    this.running = true;
    try {
      const revokedCutoff = new Date(now.getTime() - MAINTENANCE_SESSION_RETENTION_DAYS * DAY_MS);

      const [otpCodes, sessions] = await this.prisma.$transaction([
        this.prisma.otpCode.deleteMany({ where: { expiresAt: { lt: now } } }),
        this.prisma.session.deleteMany({
          where: {
            OR: [
              { expiresAt: { lt: now } },
              { revokedAt: { lt: revokedCutoff } },
            ],
          },
        }),
      ]);

      const removed = { otpCodes: otpCodes.count, sessions: sessions.count };
      // Counts only: no phone number, token hash, IP or user agent is logged.
      if (removed.otpCodes || removed.sessions) {
        this.logger.log(`pruned ${removed.otpCodes} expired OTP rows and ${removed.sessions} dead sessions`);
      }
      return removed;
    } finally {
      this.running = false;
    }
  }
}
