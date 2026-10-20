import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { displayNameOf } from '../common/names';
import { normalizeIranMobile } from '../common/phone';
import { signedFileUrl } from '../uploads/file-urls';

const SAFE = {
  id: true, username: true, firstName: true, lastName: true, displayName: true,
  avatar: true, bio: true, status: true, createdAt: true,
};
// Phone numbers are PII and must never leak through user search/listing.
const SAFE_SELF = { ...SAFE, phone: true };

function withoutPhone(user: Record<string, any>) {
  const { phone, ...rest } = user;
  return rest;
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private redis: RedisService) {}

  findAll() {
    return this.prisma.user.findMany({ select: SAFE, orderBy: { username: 'asc' } });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id }, select: SAFE });
  }

  search(query: string, excludeId: string) {
    return this.prisma.user.findMany({
      where: {
        NOT: { id: excludeId },
        OR: [
          { username:    { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
        ],
      },
      select:  SAFE,
      orderBy: { username: 'asc' },
      take:    20,
    });
  }

  /**
   * Contact sync: the client sends the numbers already stored on its phone and
   * gets back which input positions belong to an account. Only array indexes
   * are returned, never the numbers, so the response carries no phone PII and
   * a matched profile looks exactly like the one /users/search already exposes.
   */
  async matchContacts(id: string, rawPhones: string[]) {
    const requester = await this.prisma.user.findUnique({ where: { id }, select: { phone: true } });
    const normalized = rawPhones.map(phone => normalizeIranMobile(phone));
    const candidates = [...new Set(normalized.filter(phone => phone && phone !== requester?.phone))];
    if (!candidates.length) return { checked: 0, matches: [] };

    const found = await this.prisma.user.findMany({
      where:  { phone: { in: candidates } },
      select: { ...SAFE, phone: true },
    });
    const byPhone = new Map(found.map(user => [user.phone, user]));

    const seen = new Set<string>();
    const matches: { index: number; user: any }[] = [];
    normalized.forEach((phone, index) => {
      const user = phone && phone !== requester?.phone ? byPhone.get(phone) : undefined;
      // Two contacts can share a number (mobile + work); one entry per account.
      if (!user || seen.has(user.id)) return;
      seen.add(user.id);
      matches.push({ index, user: withoutPhone(user) });
    });

    const withStatus = await this.withOnlineStatus(matches.map(match => match.user));
    return {
      checked: candidates.length,
      matches: matches.map((match, position) => ({ index: match.index, user: withStatus[position] })),
    };
  }

  async updateAvatar(id: string, avatarUrl: string) {
    const user = await this.prisma.user.update({
      where: { id },
      data:  { avatar: avatarUrl },
      select: SAFE_SELF,
    });
    return { ...user, avatar: signedFileUrl(user.avatar) };
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    if (dto.username) {
      const existing = await this.prisma.user.findUnique({ where: { username: dto.username } });
      if (existing && existing.id !== id) throw new ConflictException('این نام کاربری قبلاً ثبت شده');
    }

    const data: Prisma.UserUpdateInput = { username: dto.username, bio: dto.bio, avatar: dto.avatar };

    // The name shown everywhere is derived from the two parts, so editing
    // either one rewrites it. An empty family name clears it.
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const current = await this.prisma.user.findUnique({
        where:  { id },
        select: { firstName: true, lastName: true },
      });
      const firstName = dto.firstName ?? current?.firstName ?? null;
      const lastName = dto.lastName === undefined ? current?.lastName ?? null : dto.lastName || null;
      data.firstName = firstName;
      data.lastName = lastName;
      data.displayName = displayNameOf(firstName, lastName);
    }

    const user = await this.prisma.user.update({
      where: { id },
      data,
      select: SAFE_SELF,
    });
    return { ...user, avatar: signedFileUrl(user.avatar) };
  }

  async withOnlineStatus(users: any[]) {
    const online = await this.redis.getOnlineUsers();
    return users.map(u => ({
      ...u,
      avatar: signedFileUrl(u.avatar),
      online: !!online[u.id],
    }));
  }
}
