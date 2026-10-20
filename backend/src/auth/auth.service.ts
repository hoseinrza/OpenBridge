import {
  BadRequestException, Injectable, UnauthorizedException, ConflictException,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import {
  createHash, createHmac, randomBytes, randomInt, timingSafeEqual,
} from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { signedFileUrl } from '../uploads/file-urls';
import {
  IS_PRODUCTION, JWT_SECRET, OTP_MAX_ATTEMPTS, OTP_TEST_MODE, OTP_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS,
} from '../config/env';

const SAFE = { id: true, username: true, displayName: true, avatar: true, status: true, createdAt: true };
const REFRESH_TOKEN_BYTES = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

// Compared against when the username does not exist so response timing does
// not reveal which usernames are registered.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('openbridge-timing-equalizer', 10);

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

function hashRefreshToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRefreshToken() {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

function generateOtp() {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashOtp(phone: string, code: string) {
  return createHmac('sha256', JWT_SECRET).update(`${phone}:${code}`).digest('hex');
}

function hashesMatch(storedHex: string, candidateHex: string) {
  const stored = Buffer.from(storedHex, 'hex');
  const candidate = Buffer.from(candidateHex, 'hex');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  async register(dto: RegisterDto, meta: SessionMeta = {}) {
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
    return this.withSession(this.withSignedAvatar(user), user.id, meta);
  }

  async login(dto: LoginDto, meta: SessionMeta = {}) {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    const passwordMatches = await bcrypt.compare(dto.password, user?.password ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches)
      throw new UnauthorizedException('نام کاربری یا رمز اشتباه است');

    const { password, ...safe } = user;
    return this.withSession(this.withSignedAvatar(safe), user.id, meta);
  }

  async refresh(rawRefreshToken: string, meta: SessionMeta = {}) {
    const currentHash = hashRefreshToken(rawRefreshToken);
    const session = await this.prisma.session.findUnique({
      where:   { refreshHash: currentHash },
      include: { user: { select: SAFE } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date())
      throw new UnauthorizedException('نشست منقضی شده؛ دوباره وارد شوید');

    // Rotation is conditional on the old hash still being current, so two
    // concurrent refreshes cannot both succeed with the same token.
    const nextRefreshToken = generateRefreshToken();
    const rotated = await this.prisma.session.updateMany({
      where: {
        id:          session.id,
        refreshHash: currentHash,
        revokedAt:   null,
        expiresAt:   { gt: new Date() },
      },
      data: {
        refreshHash: hashRefreshToken(nextRefreshToken),
        lastUsedAt:  new Date(),
        ip:          meta.ip?.slice(0, 64) ?? session.ip,
        userAgent:   meta.userAgent?.slice(0, 255) ?? session.userAgent,
      },
    });
    if (rotated.count !== 1) throw new UnauthorizedException('نشست منقضی شده؛ دوباره وارد شوید');

    const accessToken = this.sign(session.user.id, session.id);
    return {
      user:             this.withSignedAvatar(session.user),
      token:            accessToken,
      accessToken,
      refreshToken:     nextRefreshToken,
      sessionExpiresAt: session.expiresAt,
    };
  }

  async requestOtp(dto: RequestOtpDto) {
    if (!OTP_TEST_MODE) {
      throw new ServiceUnavailableException('ارسال پیامک هنوز فعال نشده است');
    }

    const phone = dto.phone;
    const existing = await this.prisma.user.findUnique({
      where:  { username: phone },
      select: { id: true },
    });

    const code = generateOtp();
    await this.prisma.$transaction([
      // Requesting a new code invalidates any code that is still outstanding.
      this.prisma.otpCode.updateMany({
        where: { phone, consumedAt: null },
        data:  { consumedAt: new Date() },
      }),
      this.prisma.otpCode.create({
        data: {
          phone,
          codeHash:  hashOtp(phone, code),
          expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        },
      }),
    ]);

    return {
      ok:               true,
      phone,
      isNewUser:        !existing,
      expiresInSeconds: OTP_TTL_SECONDS,
      ...(OTP_TEST_MODE ? { testCode: code } : {}),
    };
  }

  async verifyOtp(dto: VerifyOtpDto, meta: SessionMeta = {}) {
    const phone = dto.phone;
    const record = await this.prisma.otpCode.findFirst({
      where:   { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record)
      throw new UnauthorizedException('کد تأیید منقضی شده؛ دوباره درخواست کنید');
    if (record.attempts >= OTP_MAX_ATTEMPTS)
      throw new UnauthorizedException('تلاش‌های ناموفق زیاد بود؛ کد جدید درخواست کنید');
    if (!hashesMatch(record.codeHash, hashOtp(phone, dto.code))) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data:  { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('کد تأیید نادرست است');
    }

    let user = await this.prisma.user.findUnique({
      where:  { username: phone },
      select: SAFE,
    });
    if (!user && (!dto.displayName || dto.displayName.trim().length < 2))
      throw new BadRequestException('برای ساخت حساب، نام نمایشی را وارد کنید');

    // Conditional consumption makes a code single-use even if two verifies
    // race with the same code.
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: record.id, consumedAt: null },
      data:  { consumedAt: new Date() },
    });
    if (consumed.count !== 1)
      throw new UnauthorizedException('این کد قبلاً استفاده شده است');

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          username:    phone,
          displayName: dto.displayName!.trim(),
          // Phone accounts never use password login; store an unguessable hash
          // so the legacy password endpoint cannot be used for this account.
          password:    await bcrypt.hash(randomBytes(32).toString('base64url'), 10),
        },
        select: SAFE,
      });
    }

    return this.withSession(this.withSignedAvatar(user), user.id, meta);
  }

  async logout(userId: string, sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where:   { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
    return sessions.map(session => ({ ...session, current: session.id === currentSessionId }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('نشست پیدا نشد');
    return { ok: true };
  }

  private async withSession(user: any, userId: string, meta: SessionMeta) {
    const refreshToken = generateRefreshToken();
    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshHash: hashRefreshToken(refreshToken),
        ip:          meta.ip?.slice(0, 64),
        userAgent:   meta.userAgent?.slice(0, 255),
        expiresAt:   new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * DAY_MS),
      },
      select: { id: true, expiresAt: true },
    });
    return {
      user,
      token:            this.sign(userId, session.id),
      accessToken:      this.sign(userId, session.id),
      refreshToken,
      sessionExpiresAt: session.expiresAt,
    };
  }

  private withSignedAvatar(user: any) {
    return { ...user, avatar: signedFileUrl(user.avatar) };
  }

  private sign(userId: string, sessionId: string) {
    return this.jwt.sign({ sub: userId, sid: sessionId });
  }
}
