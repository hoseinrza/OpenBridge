import { Controller, Post, Body, HttpCode, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import {
  AUTH_LOGIN_LIMIT, AUTH_LOGIN_USERNAME_LIMIT, AUTH_LOGIN_WINDOW_SECONDS,
  AUTH_REGISTER_LIMIT, AUTH_REGISTER_WINDOW_SECONDS,
} from '../config/env';

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
  register(@Body() dto: RegisterDto) { return this.auth.register(dto); }

  @Post('login')
  @HttpCode(200)
  @RateLimit({
    limit: AUTH_LOGIN_LIMIT,
    windowMs: AUTH_LOGIN_WINDOW_SECONDS * 1000,
    byUsername: true,
    usernameLimit: AUTH_LOGIN_USERNAME_LIMIT,
  })
  login(@Body() dto: LoginDto) { return this.auth.login(dto); }
}
