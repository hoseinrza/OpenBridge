import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { signedFileUrl } from '../uploads/file-urls';
import { isIranMobile } from '../common/phone';

const SAFE = { id: true, username: true, displayName: true, avatar: true, bio: true, status: true, createdAt: true };

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

  async updateAvatar(id: string, avatarUrl: string) {
    const user = await this.prisma.user.update({
      where: { id },
      data:  { avatar: avatarUrl },
      select: SAFE,
    });
    return { ...user, avatar: signedFileUrl(user.avatar) };
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    if (dto.username) {
      // Phone-created accounts identify the user for OTP login; changing the
      // username would silently lock them out of their account.
      const current = await this.prisma.user.findUnique({
        where:  { id },
        select: { username: true },
      });
      if (current && isIranMobile(current.username))
        throw new BadRequestException('شماره موبایل حساب قابل تغییر نیست');
      const existing = await this.prisma.user.findUnique({ where: { username: dto.username } });
      if (existing && existing.id !== id) throw new ConflictException('این نام کاربری قبلاً ثبت شده');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data:  dto,
      select: SAFE,
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
