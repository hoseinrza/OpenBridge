import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  AccessToken, RoomServiceClient, WebhookEvent, WebhookReceiver,
} from 'livekit-server-sdk';
import {
  CALL_TOKEN_TTL_SECONDS,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_API_URL,
  LIVEKIT_CONFIGURED,
  LIVEKIT_ROOM_ADMIN,
  LIVEKIT_URL,
} from '../config/env';

export interface RoomTokenInput {
  identity: string;
  name: string;
  room: string;
  callId: string;
}

/**
 * The only holder of the LiveKit API secret. Clients receive a short-lived,
 * room-scoped JWT and the public WebSocket URL — never a key, a secret or an
 * admin credential.
 */
@Injectable()
export class LiveKitService {
  private readonly logger = new Logger(LiveKitService.name);
  private readonly roomService: RoomServiceClient | null;
  private readonly webhook: WebhookReceiver | null;

  readonly configured = LIVEKIT_CONFIGURED;
  readonly roomAdminEnabled = LIVEKIT_ROOM_ADMIN;

  constructor() {
    if (!this.configured) {
      this.logger.warn('LiveKit is not configured; call endpoints will answer 503');
      this.roomService = null;
      this.webhook = null;
      return;
    }

    this.webhook = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    this.roomService = this.roomAdminEnabled
      ? new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
      : null;
  }

  /** Public signalling URL, normalised to the ws scheme the client SDK expects. */
  get clientUrl(): string {
    if (LIVEKIT_URL.startsWith('https://')) return `wss://${LIVEKIT_URL.slice('https://'.length)}`;
    if (LIVEKIT_URL.startsWith('http://')) return `ws://${LIVEKIT_URL.slice('http://'.length)}`;
    return LIVEKIT_URL;
  }

  async issueRoomToken(input: RoomTokenInput): Promise<{ token: string; url: string; expiresIn: number }> {
    if (!this.configured) throw new ServiceUnavailableException('تماس روی این سرور پیکربندی نشده است');

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: input.identity,
      name:     input.name,
      ttl:      CALL_TOKEN_TTL_SECONDS,
      // Delivery metadata only. It is not a permission and grants nothing.
      metadata: JSON.stringify({ callId: input.callId }),
    });
    at.addGrant({
      roomJoin:        true,
      room:            input.room,
      canPublish:      true,
      canSubscribe:    true,
      // The call has no application data channel; leaving it closed is one
      // fewer surface than the default.
      canPublishData:  false,
      canUpdateOwnMetadata: false,
    });

    return { token: await at.toJwt(), url: this.clientUrl, expiresIn: CALL_TOKEN_TTL_SECONDS };
  }

  // Room admin is best-effort: a call must still end locally if the media
  // server is unreachable, so failures are logged and swallowed.
  async deleteRoom(room: string): Promise<void> {
    if (!this.roomService) return;
    try {
      await this.roomService.deleteRoom(room);
    } catch (err) {
      this.logger.warn(`could not delete room ${room}: ${(err as Error)?.message ?? 'unknown error'}`);
    }
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    if (!this.roomService) return;
    try {
      await this.roomService.removeParticipant(room, identity);
    } catch (err) {
      this.logger.warn(`could not remove participant from ${room}: ${(err as Error)?.message ?? 'unknown error'}`);
    }
  }

  /** After a restart the call map is empty, so rooms left over are orphans. */
  async deleteStaleRooms(): Promise<void> {
    if (!this.roomService) return;
    try {
      const rooms = await this.roomService.listRooms();
      for (const room of rooms) {
        if (typeof room.name === 'string' && room.name.startsWith('ob_')) {
          await this.deleteRoom(room.name);
        }
      }
    } catch (err) {
      this.logger.warn(`could not list rooms: ${(err as Error)?.message ?? 'unknown error'}`);
    }
  }

  async receiveWebhook(body: string, authHeader: string | undefined): Promise<WebhookEvent> {
    if (!this.webhook) throw new ServiceUnavailableException('دریافت رویداد LiveKit پیکربندی نشده است');
    return this.webhook.receive(body, authHeader);
  }
}
