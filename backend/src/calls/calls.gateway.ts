import {
  ConnectedSocket, MessageBody, OnGatewayDisconnect, OnGatewayInit,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { HttpException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { CallsService } from './calls.service';
import { CallEvents } from './call-events';

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

const SOCKET_EVENTS = [
  'call:incoming',
  'call:accepted',
  'call:ended',
  'call:participant-left',
];

/**
 * Socket surface for calls. Authentication happened in ChatGateway; this
 * gateway only answers events from a socket that already carries a userId and
 * re-checks the session on any operation that grants access to a room.
 */
@WebSocketGateway()
export class CallsGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private rateLimits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly calls: CallsService,
    private readonly events: CallEvents,
    private readonly prisma: PrismaService,
  ) {}

  afterInit() {
    for (const name of SOCKET_EVENTS) {
      this.events.on(name, ({ userIds, payload }) => {
        // Every socket of an account lives in the account's personal room, so
        // this reaches all tabs without keeping a socket id map here.
        this.server.to(userIds).emit(name, payload);
      });
    }
  }

  handleDisconnect(socket: Socket) {
    this.clearRateLimits(socket.id);
    const userId = socket.data?.userId;
    if (!userId) return;
    // ChatGateway removes the socket from presence; give the other gateway a
    // moment to finish, then only end calls if no socket of this account is
    // left. A second tab closing must not hang up the first tab's call.
    const timer = setTimeout(() => {
      const stillConnected = (this.server.sockets.adapter.rooms.get(userId)?.size ?? 0) > 0;
      if (!stillConnected) void this.calls.userDisconnected(userId);
    }, 1200);
    timer.unref?.();
  }

  // ── Events ─────────────────────────────────────────────────────

  @SubscribeMessage('call:invite')
  async onInvite(@ConnectedSocket() socket: Socket, @MessageBody() body: any) {
    if (!this.allowRate(socket.id, 'call:invite', 6, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌های تماس بیش از حد مجاز است' };
    }
    const denied = await this.guard(socket, true);
    if (denied) return denied;
    if (!isId(body?.toId)) return { ok: false, error: 'گیرندهٔ تماس مشخص نیست' };
    if (!this.userOnline(body.toId)) return { ok: false, error: 'کاربر در دسترس نیست' };

    try {
      return await this.calls.inviteDirect(socket.data.userId, body);
    } catch (err) {
      return this.failure(err, 'شروع تماس ناموفق بود');
    }
  }

  @SubscribeMessage('call:group-start')
  async onGroupStart(@ConnectedSocket() socket: Socket, @MessageBody() body: any) {
    if (!this.allowRate(socket.id, 'call:group-start', 4, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌های تماس بیش از حد مجاز است' };
    }
    const denied = await this.guard(socket, true);
    if (denied) return denied;
    if (!isId(body?.conversationId)) return { ok: false, error: 'گروه مشخص نیست' };

    try {
      return await this.calls.startGroupCall(socket.data.userId, body);
    } catch (err) {
      return this.failure(err, 'شروع تماس گروهی ناموفق بود');
    }
  }

  @SubscribeMessage('call:accept')
  async onAccept(@ConnectedSocket() socket: Socket, @MessageBody() body: any) {
    if (!this.allowRate(socket.id, 'call:accept', 20, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }
    const denied = await this.guard(socket, true);
    if (denied) return denied;
    if (!isId(body?.callId)) return { ok: false, error: 'تماس مشخص نیست' };

    try {
      return await this.calls.accept(socket.data.userId, body.callId);
    } catch (err) {
      return this.failure(err, 'پاسخ به تماس ناموفق بود');
    }
  }

  @SubscribeMessage('call:reject')
  async onReject(@ConnectedSocket() socket: Socket, @MessageBody() body: any) {
    if (!this.allowRate(socket.id, 'call:reject', 20, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }
    const denied = await this.guard(socket, false);
    if (denied) return denied;
    if (!isId(body?.callId)) return { ok: false, error: 'تماس مشخص نیست' };

    try {
      return await this.calls.reject(socket.data.userId, body.callId);
    } catch (err) {
      return this.failure(err, 'رد تماس ناموفق بود');
    }
  }

  @SubscribeMessage('call:cancel')
  async onCancel(@ConnectedSocket() socket: Socket, @MessageBody() body: any) {
    if (!this.allowRate(socket.id, 'call:cancel', 20, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }
    const denied = await this.guard(socket, false);
    if (denied) return denied;
    if (!isId(body?.callId)) return { ok: false, error: 'تماس مشخص نیست' };

    try {
      return await this.calls.cancel(socket.data.userId, body.callId);
    } catch (err) {
      return this.failure(err, 'لغو تماس ناموفق بود');
    }
  }

  @SubscribeMessage('call:end')
  async onEnd(@ConnectedSocket() socket: Socket, @MessageBody() body: any) {
    if (!this.allowRate(socket.id, 'call:end', 30, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }
    // Ending is safe even when the session was revoked a moment ago: it only
    // takes access away, so this path deliberately checks identity only.
    const denied = await this.guard(socket, false);
    if (denied) return denied;
    if (!isId(body?.callId)) return { ok: false, error: 'تماس مشخص نیست' };

    try {
      return await this.calls.end(socket.data.userId, body.callId);
    } catch (err) {
      return this.failure(err, 'پایان تماس ناموفق بود');
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private async guard(socket: Socket, checkSession: boolean): Promise<{ ok: false; error: string } | null> {
    const userId = socket.data?.userId;
    const sessionId = socket.data?.sessionId;
    if (typeof userId !== 'string' || !userId) {
      return { ok: false, error: 'ابتدا وارد حساب خود شوید' };
    }
    if (!checkSession) return null;
    if (typeof sessionId !== 'string' || !sessionId) {
      socket.disconnect(true);
      return { ok: false, error: 'نشست شما معتبر نیست' };
    }
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!session) {
      socket.disconnect(true);
      return { ok: false, error: 'نشست شما منقضی شده است' };
    }
    return null;
  }

  private userOnline(userId: string): boolean {
    return (this.server.sockets.adapter.rooms.get(userId)?.size ?? 0) > 0;
  }

  private allowRate(socketId: string, event: string, limit: number, windowMs: number): boolean {
    const key = `${socketId}:${event}`;
    const now = Date.now();
    const entry = this.rateLimits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  private clearRateLimits(socketId: string) {
    for (const key of this.rateLimits.keys()) {
      if (key.startsWith(`${socketId}:`)) this.rateLimits.delete(key);
    }
  }

  private failure(err: unknown, fallback: string) {
    if (err instanceof HttpException) return { ok: false, error: err.message };
    // Call payloads are deliberately absent from this log: they may carry key
    // fingerprints and room metadata.
    console.error('[socket] call event failed', (err as Error)?.message ?? err);
    return { ok: false, error: fallback };
  }
}
