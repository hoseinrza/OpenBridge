import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Request, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import {
  E2EE_CLAIM_LIMIT, E2EE_CLAIM_WINDOW_SECONDS,
  E2EE_REGISTER_LIMIT, E2EE_REGISTER_WINDOW_SECONDS,
} from '../config/env';
import { E2eeService } from './e2ee.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UploadKeyPackagesDto } from './dto/upload-key-packages.dto';

// Everything here is public key material or registration metadata. The server
// relays it between devices and cannot decrypt anything with it.
@Controller('e2ee')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class E2eeController {
  constructor(private e2ee: E2eeService) {}

  @Post('devices')
  @RateLimit({ limit: E2EE_REGISTER_LIMIT, windowMs: E2EE_REGISTER_WINDOW_SECONDS * 1000 })
  registerDevice(@Request() req, @Body() dto: RegisterDeviceDto) {
    return this.e2ee.registerDevice(req.user.id, dto);
  }

  @Get('devices')
  listDevices(@Request() req) {
    return this.e2ee.listDevices(req.user.id);
  }

  // `clientId` is the caller's own device id. Looking it up scoped to the
  // caller's account is what makes another account's device unreachable.
  @Delete('devices/:clientId')
  @RateLimit({ limit: E2EE_REGISTER_LIMIT, windowMs: E2EE_REGISTER_WINDOW_SECONDS * 1000 })
  revokeDevice(@Request() req, @Param('clientId') clientId: string) {
    return this.e2ee.revokeDevice(req.user.id, clientId);
  }

  @Post('devices/:clientId/key-packages')
  @HttpCode(201)
  @RateLimit({ limit: E2EE_REGISTER_LIMIT, windowMs: E2EE_REGISTER_WINDOW_SECONDS * 1000 })
  addKeyPackages(
    @Request() req,
    @Param('clientId') clientId: string,
    @Body() dto: UploadKeyPackagesDto,
  ) {
    return this.e2ee.addKeyPackages(req.user.id, clientId, dto.packages);
  }

  @Get('users/:userId/key-packages')
  @RateLimit({ limit: E2EE_CLAIM_LIMIT, windowMs: E2EE_CLAIM_WINDOW_SECONDS * 1000 })
  claimKeyPackages(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.e2ee.claimKeyPackages(userId);
  }
}
