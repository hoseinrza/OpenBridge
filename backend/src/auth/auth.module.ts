import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JWT_SECRET, JWT_EXPIRES_IN } from '../config/env';
import { RateLimitGuard } from '../common/rate-limit.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret:       JWT_SECRET,
      signOptions: { expiresIn: JWT_EXPIRES_IN },
    }),
  ],
  providers:   [AuthService, JwtStrategy, RateLimitGuard],
  controllers: [AuthController],
  exports:     [JwtModule],
})
export class AuthModule {}
