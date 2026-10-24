import {
  Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, RawBodyRequest, Req,
  ServiceUnavailableException, UnauthorizedException, UseGuards, BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { CallsService } from './calls.service';
import { LiveKitService } from './livekit.service';
import { CallTokenDto } from './dto/call-token.dto';

@Controller('calls')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly livekit: LiveKitService,
  ) {}

  /** Whether this deployment has been wired to a media server. */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  status() {
    return { configured: this.livekit.configured };
  }

  // A room token is minted only after the HTTP guard has checked the session,
  // and only for a participant the service has already authorized.
  @Post(':callId/token')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 30, windowMs: 10_000 })
  token(
    @Req() req,
    @Param('callId', ParseUUIDPipe) callId: string,
    @Body() dto: CallTokenDto,
  ) {
    return this.calls.token(req.user.id, callId, dto);
  }

  /** Lets a member who missed the ring still find an ongoing group call. */
  @Get('active/:conversationId')
  @UseGuards(JwtAuthGuard)
  active(@Req() req, @Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return { call: this.calls.activeGroupCall(conversationId, req.user.id) };
  }

  /**
   * LiveKit signs this body with the API secret. It is unauthenticated as HTTP
   * goes — the signature is the authentication — and must receive the raw bytes,
   * not a re-serialized object.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization: string | undefined,
  ) {
    if (!this.livekit.configured) throw new ServiceUnavailableException('LiveKit is not configured');
    const raw = req.rawBody;
    if (!raw?.length) throw new BadRequestException('raw webhook body is missing');
    if (!authorization) throw new UnauthorizedException('missing webhook signature');

    let event;
    try {
      event = await this.livekit.receiveWebhook(raw.toString('utf8'), authorization);
    } catch {
      throw new UnauthorizedException('invalid webhook signature');
    }

    await this.calls.handleWebhook(event as any);
    return { ok: true };
  }
}
