import {
  Controller, Post, Get, Delete, Body, HttpCode, Req, Param, ParseUUIDPipe, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService, SessionMeta } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard, clientIp } from '../common/rate-limit.guard';
import {
  AUTH_LOGIN_LIMIT, AUTH_LOGIN_USERNAME_LIMIT, AUTH_LOGIN_WINDOW_SECONDS,
  AUTH_REGISTER_LIMIT, AUTH_REGISTER_WINDOW_SECONDS,
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

  @Post('register')
  @RateLimit({
    limit: AUTH_REGISTER_LIMIT,
    windowMs: AUTH_REGISTER_WINDOW_SECONDS * 1000,
    byUsername: true,
  })
  register(@Body() dto: RegisterDto, @Req() request: Request) {
    return this.auth.register(dto, sessionMeta(request));
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit({
    limit: AUTH_LOGIN_LIMIT,
    windowMs: AUTH_LOGIN_WINDOW_SECONDS * 1000,
    byUsername: true,
    usernameLimit: AUTH_LOGIN_USERNAME_LIMIT,
  })
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.auth.login(dto, sessionMeta(request));
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

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  revokeSession(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) sessionId: string) {
    return this.auth.revokeSession(request.user.id, sessionId);
  }
}
