import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { JWT_SECRET } from '../../config/env';
import { signedFileUrl } from '../../uploads/file-urls';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: JWT_SECRET,
      algorithms: ['HS256'],
    });
  }

  async validate(payload: { sub?: string }) {
    if (!payload?.sub || typeof payload.sub !== 'string') throw new UnauthorizedException();
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, displayName: true, avatar: true, bio: true, status: true, createdAt: true },
    });
    if (!user) throw new UnauthorizedException();
    return { ...user, avatar: signedFileUrl(user.avatar) };
  }
}
