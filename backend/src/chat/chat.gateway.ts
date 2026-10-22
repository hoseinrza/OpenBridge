import {
  WebSocketGateway, WebSocketServer,
  SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
  ConnectedSocket, MessageBody,
} from '@nestjs/websockets';
import { HttpException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { MessagesService } from '../messages/messages.service';
import { GroupEvents } from '../messages/group-events';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { JWT_SECRET, isOriginAllowed } from '../config/env';
import { signedFileUrl } from '../uploads/file-urls';

const MAX_PACKET_BYTES = 256 * 1024;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

@WebSocketGateway({
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    credentials: true,
  },
  maxHttpBufferSize: MAX_PACKET_BYTES,
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private rateLimits = new Map<string, { count: number; resetAt: number }>();
  // One chain per conversation so an envelope's sequence number is assigned and
  // emitted in the same critical section. Per-process, like the other in-memory
  // state here; the database advisory lock is what keeps the numbering correct
  // if a second instance ever appends concurrently.
  private envelopeChains = new Map<string, Promise<unknown>>();

  constructor(
    private jwt: JwtService,
    private messages: MessagesService,
    private redis: RedisService,
    private prisma: PrismaService,
    private events: GroupEvents,
  ) {}

  // A group rename, a new photo or a new bio is a REST call (the photo has to be
  // uploaded first), so the service publishes it here and every member's open
  // window updates without waiting for the next list refresh.
  afterInit() {
    this.events.onGroupUpdated(({ memberIds, group }) => {
      this.server.to(memberIds).emit('group:updated', group);
    });
  }

  private parseUser(socket: Socket): { sub: string; sid: string } | null {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return null;
      const payload = this.jwt.verify(token, { secret: JWT_SECRET, algorithms: ['HS256'] }) as {
        sub?: unknown;
        sid?: unknown;
      };
      if (typeof payload?.sub !== 'string' || !payload.sub) return null;
      if (typeof payload.sid !== 'string' || !payload.sid) return null;
      return { sub: payload.sub, sid: payload.sid };
    } catch { return null; }
  }

  async handleConnection(socket: Socket) {
    const payload = this.parseUser(socket);
    if (!payload) {
      console.log(`[socket] rejected (bad/missing token) socket=${socket.id}`);
      socket.disconnect();
      return;
    }

    try {
      const session = await this.prisma.session.findFirst({
        where: {
          id:        payload.sid,
          userId:    payload.sub,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!session) {
        console.log(`[socket] rejected (unknown user or revoked session) socket=${socket.id}`);
        socket.disconnect();
        return;
      }
    } catch (err) {
      console.error('[socket] connection check failed', err);
      socket.disconnect();
      return;
    }

    socket.data.userId = payload.sub;
    socket.data.sessionId = payload.sid;
    socket.join(payload.sub);
    console.log(`[socket] connected user=${payload.sub} socket=${socket.id}`);

    await this.redis.addSocket(payload.sub, socket.id);
    this.server.emit('user:online', { userId: payload.sub });
  }

  async handleDisconnect(socket: Socket) {
    const { userId } = socket.data;
    console.log(`[socket] disconnected user=${userId ?? '(none)'} socket=${socket.id}`);
    this.clearRateLimits(socket.id);
    if (!userId) return;
    const stillOnline = await this.redis.removeSocket(userId, socket.id);
    if (!stillOnline) this.server.emit('user:offline', { userId });
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

  // Chains a task onto the conversation's queue. Rejections are swallowed by
  // the chain itself so one failed send cannot poison every later envelope of
  // that conversation; the caller still gets the rejected promise.
  private enqueueOrdered<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.envelopeChains.get(conversationId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    this.envelopeChains.set(conversationId, tail);
    // The queue only needs to exist while something is waiting on it, so the
    // entry is dropped as soon as this task is last in line.
    tail.then(() => {
      if (this.envelopeChains.get(conversationId) === tail) this.envelopeChains.delete(conversationId);
    });
    return result;
  }

  private failure(err: unknown, fallback: string) {
    console.error('[socket] event failed', err);
    return { ok: false, error: err instanceof HttpException ? err.message : fallback };
  }

  // ── Send message (1-to-1 via toId, group via conversationId) ─────────
  @SubscribeMessage('message:send')
  async onSend(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: {
      toId?: string; conversationId?: string; type?: string; text?: string;
      fileUrl?: string; fileName?: string; fileSize?: number;
    },
  ) {
    if (!this.allowRate(socket.id, 'message:send', 30, 10_000)) {
      return { ok: false, error: 'تعداد پیام‌های ارسالی بیش از حد مجاز است' };
    }

    try {
      if (isId(body?.conversationId)) {
        const msg = await this.messages.sendToConversation(body.conversationId, socket.data.userId, body);
        // Group broadcasts go to each participant's personal room. That way
        // members added after they connected still receive messages without
        // needing to rejoin a Socket.IO room.
        const participantIds = await this.messages.getConversationParticipantIds(body.conversationId);
        this.server.to(participantIds).emit('message:new', msg);
        return { ok: true, id: msg.id };
      }

      if (!isId(body?.toId)) return { ok: false, error: 'گیرنده مشخص نیست' };
      if (body.toId === socket.data.userId) return { ok: false, error: 'ارسال پیام به خودتان ممکن نیست' };

      const recipient = await this.prisma.user.findUnique({
        where:  { id: body.toId },
        select: { id: true },
      });
      if (!recipient) return { ok: false, error: 'کاربر پیدا نشد' };

      const msg = await this.messages.create(socket.data.userId, body.toId, body);

      // Deliver to both parties (sender is already in their room). Keep
      // `receiverId` on the wire for the existing 1-to-1 frontend, which
      // filters incoming messages by senderId/receiverId.
      this.server.to(socket.data.userId).to(body.toId).emit('message:new', { ...msg, receiverId: body.toId });

      // Auto read-receipt if receiver is online. The timer must not reject:
      // the recipient may be deleted while the receipt is pending, and an
      // unhandled rejection would take down the whole API process.
      if (await this.redis.isUserOnline(body.toId)) {
        setTimeout(async () => {
          try {
            const result = await this.messages.markRead(socket.data.userId, body.toId);
            this.server.to(socket.data.userId).emit('message:read', {
              by: body.toId,
              conversationId: result.conversationId,
            });
          } catch (err) {
            console.error('[socket] auto read receipt failed', err);
          }
        }, 1500);
      }

      return { ok: true, id: msg.id };
    } catch (err) {
      return this.failure(err, 'ارسال پیام ناموفق بود');
    }
  }

  // ── Edit a stored message ───────────────────────────────────────────────
  // The answer goes to every participant's room, sender included: another of
  // the sender's own open windows has to converge on the same bubble.
  @SubscribeMessage('message:edit')
  async onEdit(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { messageId?: string; text?: string },
  ) {
    if (!this.allowRate(socket.id, 'message:edit', 20, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }

    try {
      const message = await this.messages.editMessage(body?.messageId, socket.data.userId, body?.text);
      const participantIds = await this.messages.getConversationParticipantIds(message.conversationId);
      this.server.to(participantIds).emit('message:edited', message);
      return { ok: true, message };
    } catch (err) {
      return this.failure(err, 'ویرایش پیام ناموفق بود');
    }
  }

  // ── Delete a stored message ─────────────────────────────────────────────
  // Scope decides who hears about it: "everyone" is a change to what the chat
  // holds, so every participant is told; "me" is one viewer's preference and
  // goes only to that account's own rooms, which is what keeps every device of
  // that person in step without leaking the hide to anybody else.
  @SubscribeMessage('message:delete')
  async onDelete(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { messageId?: string; scope?: string },
  ) {
    if (!this.allowRate(socket.id, 'message:delete', 20, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }
    const scope = body?.scope;
    if (scope !== 'everyone' && scope !== 'me') return { ok: false, error: 'نوع حذف نامعتبر است' };

    try {
      const result = await this.messages.deleteMessage(body.messageId, socket.data.userId, scope);
      const targets = scope === 'everyone'
        ? await this.messages.getConversationParticipantIds(result.conversationId)
        : [socket.data.userId];
      this.server.to(targets).emit('message:deleted', result);
      return { ok: true, ...result };
    } catch (err) {
      return this.failure(err, 'حذف پیام ناموفق بود');
    }
  }

  // ── Encrypted conversations: opaque envelopes, delivered in order ──────
  // The server is a sequenced delivery service here and nothing more: it stores
  // the blob it is handed, numbers it per conversation, and emits it in that
  // order. It cannot tell a Welcome from a chat message, so a client that
  // submits garbage simply fails to decrypt on every device, including its own.
  @SubscribeMessage('e2ee:append')
  async onE2eeAppend(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { conversationId?: string; content?: string },
  ) {
    if (!this.allowRate(socket.id, 'e2ee:append', 30, 10_000)) {
      return { ok: false, error: 'تعداد بسته‌های ارسالی بیش از حد مجاز است' };
    }
    if (!isId(body?.conversationId)) return { ok: false, error: 'گفتگو مشخص نیست' };

    try {
      const envelope = await this.enqueueOrdered(body.conversationId, async () => {
        const stored = await this.messages.appendE2eeEnvelope(
          body.conversationId, socket.data.userId, body.content,
        );
        const participantIds = await this.messages.getConversationParticipantIds(body.conversationId);
        this.server.to(participantIds).emit('e2ee:envelope', stored);
        return stored;
      });
      return { ok: true, id: envelope.id, seq: envelope.seq };
    } catch (err) {
      return this.failure(err, 'ارسال بسته ناموفق بود');
    }
  }

  // Read state of an encrypted chat is one high-water mark per participant, so
  // a receipt is a sequence number rather than a message id. The event clients
  // already listen for is reused so both chat kinds clear badges the same way.
  @SubscribeMessage('e2ee:read')
  async onE2eeRead(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { conversationId?: string; upToSeq?: number },
  ) {
    // Every path answers: a client that waits for confirmation of its own read
    // mark must never hang on a rejected or ignored receipt.
    if (!this.allowRate(socket.id, 'e2ee:read', 20, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }
    if (!isId(body?.conversationId)) return { ok: false, error: 'گفتگو مشخص نیست' };

    const upToSeq = Number(body?.upToSeq);
    if (!Number.isInteger(upToSeq) || upToSeq < 0) return { ok: false, error: 'شماره بسته نامعتبر است' };

    try {
      const result = await this.messages.markE2eeRead(body.conversationId, socket.data.userId, upToSeq);
      if (result.count) {
        const participantIds = await this.messages.getConversationParticipantIds(body.conversationId);
        this.server.to(participantIds).emit('message:read', {
          by: socket.data.userId,
          conversationId: body.conversationId,
        });
      }
      // count 0 is not a failure: the mark was already at or above this point.
      return { ok: true, moved: result.count === 1 };
    } catch (err) {
      return this.failure(err, 'ثبت خوانده‌شدن ناموفق بود');
    }
  }

  // ── Typing indicators ───────────────────────────────
  @SubscribeMessage('typing:start')
  async onTypingStart(
    @ConnectedSocket() s: Socket,
    @MessageBody() body: { toId?: string; conversationId?: string },
  ) {
    if (!this.allowRate(s.id, 'typing', 20, 10_000)) return;

    try {
      if (isId(body?.conversationId)) {
        const participantIds = await this.messages.getConversationParticipantIds(body.conversationId);
        if (!participantIds.includes(s.data.userId)) return;
        this.server.to(participantIds.filter(id => id !== s.data.userId)).emit('typing:start', {
          fromId: s.data.userId,
          conversationId: body.conversationId,
        });
        return;
      }
      if (isId(body?.toId) && body.toId !== s.data.userId) {
        this.server.to(body.toId).emit('typing:start', { fromId: s.data.userId });
      }
    } catch (err) {
      console.error('[socket] typing:start failed', err);
    }
  }

  @SubscribeMessage('typing:stop')
  async onTypingStop(
    @ConnectedSocket() s: Socket,
    @MessageBody() body: { toId?: string; conversationId?: string },
  ) {
    if (!this.allowRate(s.id, 'typing', 20, 10_000)) return;

    try {
      if (isId(body?.conversationId)) {
        const participantIds = await this.messages.getConversationParticipantIds(body.conversationId);
        if (!participantIds.includes(s.data.userId)) return;
        this.server.to(participantIds.filter(id => id !== s.data.userId)).emit('typing:stop', {
          fromId: s.data.userId,
          conversationId: body.conversationId,
        });
        return;
      }
      if (isId(body?.toId) && body.toId !== s.data.userId) {
        this.server.to(body.toId).emit('typing:stop', { fromId: s.data.userId });
      }
    } catch (err) {
      console.error('[socket] typing:stop failed', err);
    }
  }

  // ── Read receipt ────────────────────────────────────
  @SubscribeMessage('messages:read')
  async onRead(
    @ConnectedSocket() s: Socket,
    @MessageBody() body: { fromId?: string; conversationId?: string },
  ) {
    if (!this.allowRate(s.id, 'messages:read', 20, 10_000)) return;

    try {
      if (isId(body?.conversationId)) {
        const participantIds = await this.messages.getConversationParticipantIds(body.conversationId);
        if (!participantIds.includes(s.data.userId)) return;
        await this.messages.markConversationRead(body.conversationId, s.data.userId);
        this.server.to(participantIds).emit('message:read', {
          by: s.data.userId,
          conversationId: body.conversationId,
        });
        return;
      }

      if (!isId(body?.fromId) || body.fromId === s.data.userId) return;
      const result = await this.messages.markRead(body.fromId, s.data.userId);
      this.server.to(body.fromId).emit('message:read', {
        by: s.data.userId,
        conversationId: result.conversationId,
      });
    } catch (err) {
      console.error('[socket] messages:read failed', err);
    }
  }

  // ── Reactions ───────────────────────────────────────
  // Tapback semantics: the same event adds, replaces or removes the caller's one
  // reaction, and every participant is told the resulting list rather than a
  // delta, so no client can drift into showing more than the people who reacted.
  @SubscribeMessage('reaction:add')
  async onReaction(
    @ConnectedSocket() s: Socket,
    @MessageBody() body: { messageId: string; emoji: string },
  ) {
    if (!this.allowRate(s.id, 'reaction:add', 20, 10_000)) {
      return { ok: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' };
    }

    try {
      const { messageId, conversationId, reactions } = await this.messages.toggleReaction(
        body?.messageId, s.data.userId, body?.emoji,
      );
      const participantIds = await this.messages.getConversationParticipantIds(conversationId);
      this.server.to(participantIds).emit('reaction:changed', {
        messageId,
        conversationId,
        reactions,
      });
      return { ok: true, reactions };
    } catch (err) {
      return this.failure(err, 'ثبت ری‌اکشن ناموفق بود');
    }
  }

  // ── WebRTC call signaling (plain relay between the two peers' rooms) ──
  @SubscribeMessage('call:invite')
  async onCallInvite(
    @ConnectedSocket() s: Socket,
    @MessageBody() body: { toId: string; callType: 'video' | 'audio' },
  ) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    if (body.callType !== 'video' && body.callType !== 'audio') return;

    try {
      // Never trust caller metadata from the client.
      const caller = await this.prisma.user.findUnique({
        where:  { id: s.data.userId },
        select: { id: true, username: true, displayName: true, avatar: true },
      });
      if (!caller) return;

      this.server.to(body.toId).emit('call:incoming', {
        fromId: s.data.userId,
        callType: body.callType,
        caller: {
          id:     caller.id,
          name:   caller.displayName || caller.username,
          avatar: signedFileUrl(caller.avatar) ?? '',
        },
      });
    } catch (err) {
      console.error('[socket] call:invite failed', err);
    }
  }

  @SubscribeMessage('call:cancel')
  onCallCancel(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    this.server.to(body.toId).emit('call:cancelled', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:accept')
  onCallAccept(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    this.server.to(body.toId).emit('call:accepted', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:reject')
  onCallReject(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    this.server.to(body.toId).emit('call:rejected', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:end')
  onCallEnd(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    this.server.to(body.toId).emit('call:ended', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:offer')
  onCallOffer(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string; sdp: unknown }) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    if (!body.sdp || typeof body.sdp !== 'object') return;
    this.server.to(body.toId).emit('call:offer', { fromId: s.data.userId, sdp: body.sdp });
  }

  @SubscribeMessage('call:answer')
  onCallAnswer(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string; sdp: unknown }) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    if (!body.sdp || typeof body.sdp !== 'object') return;
    this.server.to(body.toId).emit('call:answer', { fromId: s.data.userId, sdp: body.sdp });
  }

  @SubscribeMessage('call:ice-candidate')
  onCallIceCandidate(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string; candidate: unknown }) {
    if (!this.allowRate(s.id, 'call', 40, 10_000)) return;
    if (!isId(body?.toId) || body.toId === s.data.userId) return;
    if (!body.candidate || typeof body.candidate !== 'object') return;
    this.server.to(body.toId).emit('call:ice-candidate', { fromId: s.data.userId, candidate: body.candidate });
  }
}
