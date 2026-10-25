import {
  Controller, Post, Get, Delete, Body, HttpCode, Req, Param, ParseUUIDPipe, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService, SessionMeta } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SignupDto } from './dto/signup.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard, clientIp } from '../common/rate-limit.guard';
import {
  AUTH_OTP_REQUEST_LIMIT, AUTH_OTP_REQUEST_PHONE_LIMIT, AUTH_OTP_VERIFY_LIMIT,
  AUTH_SIGNUP_LIMIT, AUTH_OTP_WINDOW_SECONDS,
} from '../config/env';

function sessionMeta(request: Request): SessionMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ip:        clientIp(request),
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
  };
}

interface AuthenticatedRequest extends Request {
  user: { id: string; sessionId: string };
}

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  @RateLimit({
    limit: AUTH_OTP_REQUEST_LIMIT,
    windowMs: AUTH_OTP_WINDOW_SECONDS * 1000,
    byPhone: true,
    phoneLimit: AUTH_OTP_REQUEST_PHONE_LIMIT,
  })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @RateLimit({ limit: AUTH_OTP_VERIFY_LIMIT, windowMs: AUTH_OTP_WINDOW_SECONDS * 1000 })
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() request: Request) {
    return this.auth.verifyOtp(dto, sessionMeta(request));
  }

  // Second half of the sign-up: the phone is already verified, this only turns
  // the issued token into an account.
  @Post('signup')
  @HttpCode(201)
  @RateLimit({ limit: AUTH_SIGNUP_LIMIT, windowMs: AUTH_OTP_WINDOW_SECONDS * 1000 })
  signup(@Body() dto: SignupDto, @Req() request: Request) {
    return this.auth.completeSignup(dto, sessionMeta(request));
  }

  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ limit: 60, windowMs: 15 * 60 * 1000 })
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request) {
    return this.auth.refresh(dto.refreshToken, sessionMeta(request));
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  logout(@Req() request: AuthenticatedRequest) {
    return this.auth.logout(request.user.id, request.user.sessionId);
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  listSessions(@Req() request: AuthenticatedRequest) {
    return this.auth.listSessions(request.user.id, request.user.sessionId);
  }

  // New sessions since this one last acknowledged them. The answer is a list of
  // session rows, not opaque events, so the banner can show browser, IP and time
  // without a second request.
  @Get('security-events')
  @UseGuards(JwtAuthGuard)
  securityEvents(@Req() request: AuthenticatedRequest) {
    return this.auth.securityEvents(request.user.id, request.user.sessionId);
  }

  @Post('security-events/ack')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  acknowledgeSecurityEvents(@Req() request: AuthenticatedRequest) {
    return this.auth.acknowledgeSecurityEvents(request.user.id, request.user.sessionId);
  }

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  revokeSession(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) sessionId: string) {
    return this.auth.revokeSession(request.user.id, request.user.sessionId, sessionId);
  }
}
