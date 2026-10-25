import {
  Injectable, UnauthorizedException, ConflictException,
  NotFoundException, ForbiddenException, ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import {
  createHash, createHmac, randomBytes, randomInt, timingSafeEqual,
} from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SignupDto } from './dto/signup.dto';
import { displayNameOf } from '../common/names';
import { SessionSockets } from '../common/session-sockets';
import { signedFileUrl } from '../uploads/file-urls';
import {
  IS_PRODUCTION, JWT_SECRET, OTP_MAX_ATTEMPTS, OTP_TEST_MODE, OTP_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS, SESSION_REVOKE_COOLDOWN_DAYS, SIGNUP_TOKEN_TTL_SECONDS,
} from '../config/env';

const SAFE = {
  id: true, username: true, firstName: true, lastName: true, displayName: true,
  phone: true, avatar: true, status: true, createdAt: true,
};
const REFRESH_TOKEN_BYTES = 48;
const DAY_MS = 24 * 60 * 60 * 1000;
const IRAN_MOBILE = /^09\d{9}$/;

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

// User-facing counts are Persian digits; building them from code points keeps
// the number in sync with the configured cooldown.
function faDigits(value: number | string) {
  return String(value).replace(/[0-9]/g, digit => String.fromCharCode(0x06f0 + Number(digit)));
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private sessionSockets: SessionSockets,
  ) {}

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
    // Accounts created before the `phone` column existed may still use the
    // phone number as their username, so treat those as the same account.
    const existing = await this.prisma.user.findFirst({
      where:  { OR: [{ phone }, { phone: null, username: phone }] },
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

    const user = await this.prisma.user.findFirst({
      where:  { OR: [{ phone }, { phone: null, username: phone }] },
      select: SAFE,
    });

    // Conditional consumption makes a code single-use even if two verifies
    // race with the same code.
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: record.id, consumedAt: null },
      data:  { consumedAt: new Date() },
    });
    if (consumed.count !== 1)
      throw new UnauthorizedException('این کد قبلاً استفاده شده است');

    if (!user) {
      // The number is verified but no account exists yet. Hand back a
      // short-lived token so the remaining sign-up steps can each get their
      // own screen without re-asking for the code.
      return {
        requiresSignup:         true,
        phone,
        signupToken:            this.jwt.sign(
          { pur: 'signup', phone },
          { expiresIn: SIGNUP_TOKEN_TTL_SECONDS },
        ),
        signupExpiresInSeconds: SIGNUP_TOKEN_TTL_SECONDS,
      };
    }

    if (user.phone) return this.withSession(this.withSignedAvatar(user), user.id, meta);

    // Legacy account whose username was the phone number: link the verified
    // number so the next sign-in finds it directly.
    const linked = await this.prisma.user.update({
      where:  { id: user.id },
      data:   { phone },
      select: SAFE,
    });
    return this.withSession(this.withSignedAvatar(linked), user.id, meta);
  }

  async completeSignup(dto: SignupDto, meta: SessionMeta = {}) {
    const phone = this.verifySignupToken(dto.signupToken);

    const existing = await this.prisma.user.findFirst({
      where:  { OR: [{ phone }, { phone: null, username: phone }] },
      select: { id: true },
    });
    if (existing) throw new ConflictException('برای این شماره حسابی ساخته شده؛ با همان کد وارد شوید');

    // Checked before creating anything so a taken handle leaves the signup
    // token reusable and the user can simply pick another one.
    const taken = await this.prisma.user.findUnique({
      where:  { username: dto.username },
      select: { id: true },
    });
    if (taken) throw new ConflictException('این نام کاربری قبلاً ثبت شده');

    const user = await this.prisma.user.create({
      data: {
        username:    dto.username,
        firstName:   dto.firstName,
        lastName:    dto.lastName ?? null,
        displayName: displayNameOf(dto.firstName, dto.lastName),
        phone,
        // These accounts never sign in with a password; the column keeps an
        // unguessable value so nothing can authenticate through it.
        password: await bcrypt.hash(randomBytes(32).toString('base64url'), 10),
      },
      select: SAFE,
    });
    return this.withSession(this.withSignedAvatar(user), user.id, meta);
  }

  private verifySignupToken(token: string): string {
    let payload: { pur?: string; phone?: string };
    try {
      payload = this.jwt.verify(token, { algorithms: ['HS256'] });
    } catch (error) {
      throw new UnauthorizedException(
        (error as Error).name === 'TokenExpiredError'
          ? 'مهلت ثبت‌نام تمام شد؛ دوباره کد بگیرید'
          : 'کد تأیید معتبر نیست',
      );
    }
    if (payload?.pur !== 'signup' || typeof payload.phone !== 'string' || !IRAN_MOBILE.test(payload.phone))
      throw new UnauthorizedException('کد تأیید معتبر نیست');

    return payload.phone;
  }

  async logout(userId: string, sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    this.sessionSockets.disconnect(sessionId);
    return { ok: true };
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where:   { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
    const current = sessions.find(session => session.id === currentSessionId);
    // The age rule is answered here rather than recomputed in the UI from
    // Date.now(), so the button and the endpoint cannot disagree.
    const canRevokeOthers = current
      ? Date.now() - current.createdAt.getTime() >= SESSION_REVOKE_COOLDOWN_DAYS * DAY_MS
      : false;
    return {
      sessions: sessions.map(session => ({
        ...session,
        current: session.id === currentSessionId,
        online:  this.sessionSockets.isOnline(session.id),
      })),
      canRevokeOthers,
      revokeCooldownDays: SESSION_REVOKE_COOLDOWN_DAYS,
    };
  }

  /**
   * Sessions created after this session's mark, excluding itself. Reading the
   * rows straight from `sessions` keeps the alert honest without a second event
   * table, and the mark lives on the session so one device acknowledging the
   * alert never hides it from another.
   */
  async securityEvents(userId: string, currentSessionId: string) {
    const current = await this.prisma.session.findFirst({
      where: { id: currentSessionId, userId, revokedAt: null },
      select: { createdAt: true, securitySeenAt: true },
    });
    if (!current) throw new UnauthorizedException();

    const since = current.securitySeenAt ?? current.createdAt;
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        id:         { not: currentSessionId },
        revokedAt:  null,
        expiresAt:  { gt: new Date() },
        createdAt:  { gt: since },
      },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
    });
    return sessions.map(session => ({
      ...session,
      online: this.sessionSockets.isOnline(session.id),
    }));
  }

  async acknowledgeSecurityEvents(userId: string, currentSessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: currentSessionId, userId, revokedAt: null },
      data:  { securitySeenAt: new Date() },
    });
    return { ok: true };
  }

  async revokeSession(userId: string, requesterSessionId: string, targetSessionId: string) {
    // Ownership is settled before the age rule: a session that is not yours
    // answers like one that never existed, whatever the caller's device age.
    const target = await this.prisma.session.findFirst({
      where: { id: targetSessionId, userId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('نشست پیدا نشد');

    if (targetSessionId !== requesterSessionId) {
      const requester = await this.prisma.session.findFirst({
        where: { id: requesterSessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { createdAt: true },
      });
      if (!requester) throw new UnauthorizedException();
      const ageMs = Date.now() - requester.createdAt.getTime();
      if (ageMs < SESSION_REVOKE_COOLDOWN_DAYS * DAY_MS) {
        throw new ForbiddenException(
          `این دستگاه تازه وارد شده است؛ تا ${faDigits(SESSION_REVOKE_COOLDOWN_DAYS)} روز نمی‌تواند دستگاه‌های دیگر را خارج کند`,
        );
      }
    }

    const result = await this.prisma.session.updateMany({
      where: { id: targetSessionId, userId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('نشست پیدا نشد');
    this.sessionSockets.disconnect(targetSessionId);
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
        // A session is not news to itself: without this the first thing a new
        // login would show is an alert about every session that predates it.
        securitySeenAt: new Date(),
        expiresAt:   new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * DAY_MS),
      },
      select: { id: true, createdAt: true, expiresAt: true },
    });
    // The devices already signed in hear about this one immediately; a device
    // that was offline still finds it through GET /auth/security-events.
    this.sessionSockets.toUser(userId, 'session:new', {
      id:        session.id,
      ip:        meta.ip?.slice(0, 64) ?? null,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      createdAt: session.createdAt,
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
