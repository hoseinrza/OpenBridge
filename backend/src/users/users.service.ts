import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

const SAFE = { id: true, username: true, avatar: true, bio: true, status: true, createdAt: true };

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
        username: { contains: query },
        NOT:      { id: excludeId },
      },
      select:  SAFE,
      orderBy: { username: 'asc' },
      take:    20,
    });
  }

  async updateAvatar(id: string, avatarUrl: string) {
    return this.prisma.user.update({
      where: { id },
      data:  { avatar: avatarUrl },
      select: SAFE,
    });
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    if (dto.username) {
      const existing = await this.prisma.user.findUnique({ where: { username: dto.username } });
      if (existing && existing.id !== id) throw new ConflictException('این نام کاربری قبلاً ثبت شده');
    }
    return this.prisma.user.update({
      where: { id },
      data:  dto,
      select: SAFE,
    });
  }

  async withOnlineStatus(users: any[]) {
    const online = await this.redis.getOnlineUsers();
    return users.map(u => ({ ...u, online: !!online[u.id] }));
  }
}
