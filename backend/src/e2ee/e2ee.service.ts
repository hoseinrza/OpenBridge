import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  E2EE_MAX_DEVICES_PER_USER, E2EE_MAX_PACKAGES_PER_DEVICE,
} from '../config/env';
import { RegisterDeviceDto } from './dto/register-device.dto';

// A claim can lose individual rows to a concurrent claim, so it re-reads what
// is still missing a bounded number of times before giving up.
const CLAIM_ATTEMPTS = 3;

// One answer for "no such account", "no registered device" and "the pool is
// empty": this endpoint must not become a way to find out which phone numbers
// have an account or whether their app is currently installed.
const NO_PUBLIC_KEYS = 'این کاربر در حال حاضر کلید عمومی قابل‌استفاده‌ای ندارد';

@Injectable()
export class E2eeService {
  constructor(private prisma: PrismaService) {}

  // Idempotent by (user, clientId): an app relaunch refreshes lastSeenAt and can
  // rename itself, it never mints a second device.
  async registerDevice(userId: string, dto: RegisterDeviceDto) {
    const existing = await this.prisma.device.findUnique({
      where: { userId_clientId: { userId, clientId: dto.clientId } },
    });

    // A revoked clientId stays blocked on purpose. Coming back online has to be
    // a new device with new keys, not a silent re-activation of an id a user
    // already removed from their list.
    if (existing?.revokedAt) {
      throw new ConflictException('این دستگاه لغو شده است؛ برای ثبت دوباره شناسه تازه‌ای بسازید');
    }

    if (!existing) {
      const active = await this.prisma.device.count({ where: { userId, revokedAt: null } });
      if (active >= E2EE_MAX_DEVICES_PER_USER) {
        throw new ConflictException(`حداکثر ${E2EE_MAX_DEVICES_PER_USER} دستگاه برای هر حساب مجاز است`);
      }
    }

    const device = existing
      ? await this.prisma.device.update({
        where: { id: existing.id },
        data:  { label: dto.label ?? existing.label, lastSeenAt: new Date() },
      })
      : await this.prisma.device.create({
        data: { userId, clientId: dto.clientId, label: dto.label ?? null },
      });

    return this.deviceView(device, await this.availableCount(device.id));
  }

  // Devices refill their own pool; the server never generates key material and
  // could not read it if it wanted to.
  async addKeyPackages(userId: string, clientId: string, packages: string[]) {
    const device = await this.ownDevice(userId, clientId);
    const available = await this.availableCount(device.id);
    if (available + packages.length > E2EE_MAX_PACKAGES_PER_DEVICE) {
      throw new BadRequestException(
        `استخر کلید این دستگاه پر است؛ پیش از ${available} بسته دیگر جا نیست`,
      );
    }

    await this.prisma.keyPackage.createMany({
      data: packages.map(content => ({ deviceId: device.id, content })),
    });
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

    return { available: available + packages.length };
  }

  async listDevices(userId: string) {
    const devices = await this.prisma.device.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (!devices.length) return [];

    const counts = await this.prisma.keyPackage.groupBy({
      by:    ['deviceId'],
      where: { deviceId: { in: devices.map(device => device.id) }, consumedAt: null },
      _count: { _all: true },
    });
    const byDevice = new Map(counts.map(row => [row.deviceId, row._count._all]));
    return devices.map(device => this.deviceView(device, byDevice.get(device.id) ?? 0));
  }

  async revokeDevice(userId: string, clientId: string) {
    const device = await this.ownDevice(userId, clientId);

    // Both statements in one transaction: a claim that already selected these
    // rows blocks on the row lock and then matches nothing, so a revoked device
    // cannot hand out keys after this call returns. The delete covers used and
    // unused rows alike — nothing about a device the user removed is retained.
    const [, removed] = await this.prisma.$transaction([
      this.prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } }),
      this.prisma.keyPackage.deleteMany({ where: { deviceId: device.id } }),
    ]);

    return { revoked: true, removedKeyPackages: removed.count };
  }

  /**
   * Hand a caller one fresh KeyPackage per active device of `targetUserId`, so
   * it can add every device of that user to a group. Consumption is atomic: a
   * package is never returned to two callers.
   *
   * A claim that is never used (the caller crashed) burns one package per
   * device. That is the intended trade for having no server-side state that
   * could be read back as plaintext, and clients refill the pool when it runs
   * low.
   */
  async claimKeyPackages(targetUserId: string) {
    const devices = await this.prisma.device.findMany({
      where: { userId: targetUserId, revokedAt: null },
      select: { id: true },
    });
    if (!devices.length) throw new NotFoundException(NO_PUBLIC_KEYS);

    const claimed = new Map<string, string>();
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS && claimed.size < devices.length; attempt += 1) {
      const pending = devices.filter(device => !claimed.has(device.id)).map(device => device.id);
      const candidates = await this.prisma.keyPackage.findMany({
        where:  { deviceId: { in: pending }, consumedAt: null },
        orderBy: [{ deviceId: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, deviceId: true },
      });

      // Oldest package per device: pools are refilled in batches, and consuming
      // first-in lets an abandoned upload expire instead of living forever.
      const picks: string[] = [];
      const picked = new Set<string>();
      for (const candidate of candidates) {
        if (picked.has(candidate.deviceId)) continue;
        picked.add(candidate.deviceId);
        picks.push(candidate.id);
      }
      if (!picks.length) break;

      const claimToken = randomBytes(16).toString('hex');
      await this.prisma.keyPackage.updateMany({
        where: { id: { in: picks }, consumedAt: null },
        data:  { consumedAt: new Date(), claimToken },
      });
      // The update re-checked `consumedAt IS NULL`, so the rows carrying this
      // token are exactly the ones this claim won.
      const won = await this.prisma.keyPackage.findMany({
        where:  { claimToken },
        select: { deviceId: true, content: true },
      });
      for (const row of won) claimed.set(row.deviceId, row.content);
    }

    if (claimed.size < devices.length) throw new NotFoundException(NO_PUBLIC_KEYS);
    return { packages: devices.map(device => claimed.get(device.id)) };
  }

  // Revoking and topping up a pool are addressed by the client's own id, which
  // is only meaningful inside (userId, clientId) — so another account can never
  // reach this device even if it guesses the id.
  private async ownDevice(userId: string, clientId: string) {
    const device = await this.prisma.device.findUnique({
      where: { userId_clientId: { userId, clientId } },
    });
    if (!device) throw new NotFoundException('دستگاه پیدا نشد');
    if (device.revokedAt) throw new ConflictException('این دستگاه لغو شده است');
    return device;
  }

  private availableCount(deviceId: string) {
    return this.prisma.keyPackage.count({ where: { deviceId, consumedAt: null } });
  }

  private deviceView(device: { id: string; clientId: string; label: string | null; createdAt: Date; lastSeenAt: Date }, availableKeyPackages: number) {
    return {
      id:                 device.id,
      clientId:           device.clientId,
      label:              device.label,
      createdAt:          device.createdAt,
      lastSeenAt:         device.lastSeenAt,
      availableKeyPackages,
    };
  }
}
