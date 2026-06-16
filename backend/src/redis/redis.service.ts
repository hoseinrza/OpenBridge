import { Injectable } from '@nestjs/common';

/**
 * In-memory replacement for Redis — sufficient for a single dev/demo instance.
 * Swap back to ioredis-backed implementation when scaling beyond one process.
 */
@Injectable()
export class RedisService {
  private onlineUsers = new Map<string, string>();

  async setUserOnline(userId: string, socketId: string) {
    this.onlineUsers.set(userId, socketId);
  }

  async setUserOffline(userId: string) {
    this.onlineUsers.delete(userId);
  }

  async getOnlineUsers(): Promise<Record<string, string>> {
    return Object.fromEntries(this.onlineUsers);
  }

  async isUserOnline(userId: string): Promise<boolean> {
    return this.onlineUsers.has(userId);
  }
}
