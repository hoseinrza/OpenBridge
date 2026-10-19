import { Injectable } from '@nestjs/common';

/**
 * In-memory presence tracking — sufficient for a single dev/demo instance.
 * Tracks every socket per user so a second device disconnecting does not mark
 * the user offline while another session is still connected.
 */
@Injectable()
export class RedisService {
  private onlineUsers = new Map<string, Set<string>>();

  async addSocket(userId: string, socketId: string) {
    const sockets = this.onlineUsers.get(userId) ?? new Set<string>();
    sockets.add(socketId);
    this.onlineUsers.set(userId, sockets);
  }

  // Returns true when the user still has at least one connected socket.
  async removeSocket(userId: string, socketId: string): Promise<boolean> {
    const sockets = this.onlineUsers.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.onlineUsers.delete(userId);
      return false;
    }
    return true;
  }

  async getOnlineUsers(): Promise<Record<string, string>> {
    return Object.fromEntries([...this.onlineUsers].map(([userId, sockets]) => [userId, [...sockets][0]]));
  }

  async isUserOnline(userId: string): Promise<boolean> {
    return this.onlineUsers.has(userId);
  }
}
