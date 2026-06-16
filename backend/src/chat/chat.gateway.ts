import {
  WebSocketGateway, WebSocketServer,
  SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect,
  ConnectedSocket, MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { MessagesService } from '../messages/messages.service';
import { RedisService } from '../redis/redis.service';

@WebSocketGateway({
  cors: { origin: true, credentials: true },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(
    private jwt: JwtService,
    private messages: MessagesService,
    private redis: RedisService,
  ) {}

  private parseUser(socket: Socket): { sub: string } | null {
    try {
      const token = socket.handshake.auth?.token;
      return this.jwt.verify(token, { secret: process.env.JWT_SECRET ?? 'secret' }) as any;
    } catch { return null; }
  }

  async handleConnection(socket: Socket) {
    const payload = this.parseUser(socket);
    if (!payload) { socket.disconnect(); return; }

    socket.data.userId = payload.sub;
    socket.join(payload.sub);
    await this.redis.setUserOnline(payload.sub, socket.id);
    this.server.emit('user:online', { userId: payload.sub });
  }

  async handleDisconnect(socket: Socket) {
    const { userId } = socket.data;
    if (!userId) return;
    await this.redis.setUserOffline(userId);
    this.server.emit('user:offline', { userId });
  }

  // ── Send message ────────────────────────────────────
  @SubscribeMessage('message:send')
  async onSend(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: {
      toId: string; type?: string; text?: string;
      fileUrl?: string; fileName?: string; fileSize?: number;
    },
  ) {
    const msg = await this.messages.create(socket.data.userId, body.toId, body);

    // Deliver to both parties (sender is already in their room)
    this.server.to(socket.data.userId).to(body.toId).emit('message:new', msg);

    // Auto read-receipt if receiver is online
    if (await this.redis.isUserOnline(body.toId)) {
      setTimeout(async () => {
        await this.messages.markRead(socket.data.userId, body.toId);
        this.server.to(socket.data.userId).emit('message:read', { by: body.toId });
      }, 1500);
    }
  }

  // ── Typing indicators ───────────────────────────────
  @SubscribeMessage('typing:start')
  onTypingStart(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    this.server.to(body.toId).emit('typing:start', { fromId: s.data.userId });
  }

  @SubscribeMessage('typing:stop')
  onTypingStop(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    this.server.to(body.toId).emit('typing:stop', { fromId: s.data.userId });
  }

  // ── Read receipt ────────────────────────────────────
  @SubscribeMessage('messages:read')
  async onRead(@ConnectedSocket() s: Socket, @MessageBody() body: { fromId: string }) {
    await this.messages.markRead(body.fromId, s.data.userId);
    this.server.to(body.fromId).emit('message:read', { by: s.data.userId });
  }

  // ── Reactions ───────────────────────────────────────
  @SubscribeMessage('reaction:add')
  async onReaction(
    @ConnectedSocket() s: Socket,
    @MessageBody() body: { messageId: string; emoji: string; toId: string },
  ) {
    const reaction = await this.messages.addReaction(body.messageId, s.data.userId, body.emoji);
    this.server.to(s.data.userId).to(body.toId).emit('reaction:added', {
      messageId: body.messageId,
      ...reaction,
    });
  }

  // ── WebRTC call signaling (plain relay between the two peers' rooms) ──
  @SubscribeMessage('call:invite')
  onCallInvite(
    @ConnectedSocket() s: Socket,
    @MessageBody() body: { toId: string; callType: 'video' | 'audio'; caller: { id: string; name: string; avatar: string } },
  ) {
    this.server.to(body.toId).emit('call:incoming', {
      fromId: s.data.userId,
      callType: body.callType,
      caller: body.caller,
    });
  }

  @SubscribeMessage('call:cancel')
  onCallCancel(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    this.server.to(body.toId).emit('call:cancelled', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:accept')
  onCallAccept(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    this.server.to(body.toId).emit('call:accepted', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:reject')
  onCallReject(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    this.server.to(body.toId).emit('call:rejected', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:end')
  onCallEnd(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string }) {
    this.server.to(body.toId).emit('call:ended', { fromId: s.data.userId });
  }

  @SubscribeMessage('call:offer')
  onCallOffer(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string; sdp: any }) {
    this.server.to(body.toId).emit('call:offer', { fromId: s.data.userId, sdp: body.sdp });
  }

  @SubscribeMessage('call:answer')
  onCallAnswer(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string; sdp: any }) {
    this.server.to(body.toId).emit('call:answer', { fromId: s.data.userId, sdp: body.sdp });
  }

  @SubscribeMessage('call:ice-candidate')
  onCallIceCandidate(@ConnectedSocket() s: Socket, @MessageBody() body: { toId: string; candidate: any }) {
    this.server.to(body.toId).emit('call:ice-candidate', { fromId: s.data.userId, candidate: body.candidate });
  }
}
