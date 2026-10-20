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

  async validate(payload: { sub?: string; sid?: string }) {
    if (!payload?.sub || typeof payload.sub !== 'string') throw new UnauthorizedException();
    if (!payload.sid || typeof payload.sid !== 'string') throw new UnauthorizedException();

    // A valid signature is not enough: the session must still be active, so
    // logout and "revoke session" invalidate access tokens immediately.
    const session = await this.prisma.session.findFirst({
      where: {
        id:        payload.sid,
        userId:    payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id:   true,
        user: {
          select: { id: true, username: true, displayName: true, phone: true, avatar: true, bio: true, status: true, createdAt: true },
        },
      },
    });
    if (!session) throw new UnauthorizedException();

    return { ...session.user, avatar: signedFileUrl(session.user.avatar), sessionId: session.id };
  }
}
