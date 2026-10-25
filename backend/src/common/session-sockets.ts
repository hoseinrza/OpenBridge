import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

/**
 * Which sockets belong to which session. Presence is per device rather than per
 * account: the sessions sheet has to say whether *that* phone is connected, and
 * revoking one device must close its sockets without disturbing the others.
 */
@Injectable()
export class SessionSockets {
  private server: Server | null = null;

  private sockets = new Map<string, Set<Socket>>();

  setServer(server: Server) {
    this.server = server;
  }

  add(sessionId: string, socket: Socket) {
    let group = this.sockets.get(sessionId);
    if (!group) {
      group = new Set();
      this.sockets.set(sessionId, group);
    }
    group.add(socket);
  }

  remove(sessionId: string, socket: Socket) {
    const group = this.sockets.get(sessionId);
    if (!group) return;
    group.delete(socket);
    if (group.size === 0) this.sockets.delete(sessionId);
  }

  isOnline(sessionId: string) {
    return (this.sockets.get(sessionId)?.size ?? 0) > 0;
  }

  /** Close every live socket of a session that was just signed out. */
  disconnect(sessionId: string) {
    const group = this.sockets.get(sessionId);
    if (!group) return;
    for (const socket of [...group]) {
      socket.emit('session:revoked', { reason: 'revoked' });
      socket.disconnect(true);
    }
    this.sockets.delete(sessionId);
  }

  /** Broadcast to every device currently signed into this account. */
  toUser(userId: string, event: string, payload: unknown) {
    this.server?.to(userId).emit(event, payload);
  }
}
