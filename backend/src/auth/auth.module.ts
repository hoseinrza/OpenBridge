import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JWT_SECRET, JWT_EXPIRES_IN } from '../config/env';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { SessionSockets } from '../common/session-sockets';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret:       JWT_SECRET,
      signOptions: { expiresIn: JWT_EXPIRES_IN },
    }),
  ],
  providers:   [AuthService, JwtStrategy, RateLimitGuard, SessionSockets],
  controllers: [AuthController],
  exports:     [JwtModule, SessionSockets],
})
export class AuthModule {}
