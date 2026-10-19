import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { signedFileUrl } from '../uploads/file-urls';

const SAFE = { id: true, username: true, displayName: true, avatar: true, status: true, createdAt: true };

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (exists) throw new ConflictException('این نام کاربری قبلاً ثبت شده');

    const user = await this.prisma.user.create({
      data: {
        username:    dto.username,
        displayName: dto.displayName,
        password:    await bcrypt.hash(dto.password, 10),
      },
      select: SAFE,
    });
    return { user: this.withSignedAvatar(user), token: this.sign(user.id) };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (!user || !(await bcrypt.compare(dto.password, user.password)))
      throw new UnauthorizedException('نام کاربری یا رمز اشتباه است');

    const { password, ...safe } = user;
    return { user: this.withSignedAvatar(safe), token: this.sign(user.id) };
  }

  private withSignedAvatar(user: any) {
    return { ...user, avatar: signedFileUrl(user.avatar) };
  }

  private sign(userId: string) {
    return this.jwt.sign({ sub: userId });
  }
}
