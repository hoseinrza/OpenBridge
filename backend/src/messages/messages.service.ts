import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const WITH_RELATIONS = {
  sender:    { select: { id: true, username: true, avatar: true } },
  reactions: true,
};

const PARTNER_SELECT = { id: true, username: true, avatar: true, bio: true, status: true };

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  getConversation(myId: string, otherId: string, take = 50, skip = 0) {
    return this.prisma.message.findMany({
      where: {
        OR: [
          { senderId: myId,    receiverId: otherId },
          { senderId: otherId, receiverId: myId    },
        ],
      },
      include:  WITH_RELATIONS,
      orderBy:  { createdAt: 'asc' },
      take,
      skip,
    });
  }

  // Builds the user's "conversation list": every person they've exchanged
  // messages with, ordered by most recent activity, with an unread count.
  async listConversations(myId: string) {
    const messages = await this.prisma.message.findMany({
      where:   { OR: [{ senderId: myId }, { receiverId: myId }] },
      orderBy: { createdAt: 'desc' },
      select: {
        senderId: true, receiverId: true, read: true,
        sender:   { select: PARTNER_SELECT },
        receiver: { select: PARTNER_SELECT },
      },
    });

    const order = [];
    const byPartner = new Map();

    for (const m of messages) {
      const mine    = m.senderId === myId;
      const partner = mine ? m.receiver : m.sender;
      if (!byPartner.has(partner.id)) {
        byPartner.set(partner.id, { user: partner, unread: 0 });
        order.push(partner.id);
      }
      if (!mine && !m.read) byPartner.get(partner.id).unread += 1;
    }

    return order.map(id => byPartner.get(id));
  }

  create(senderId: string, receiverId: string, data: {
    type?: string; text?: string; fileUrl?: string; fileName?: string; fileSize?: number;
  }) {
    return this.prisma.message.create({
      data: {
        senderId,
        receiverId,
        type:     (data.type as any) ?? 'TEXT',
        text:     data.text,
        fileUrl:  data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
      },
      include: WITH_RELATIONS,
    });
  }

  markRead(senderId: string, receiverId: string) {
    return this.prisma.message.updateMany({
      where: { senderId, receiverId, read: false },
      data:  { read: true },
    });
  }

  async addReaction(messageId: string, userId: string, emoji: string) {
    return this.prisma.reaction.upsert({
      where:  { userId_messageId_emoji: { userId, messageId, emoji } },
      create: { messageId, userId, emoji },
      update: {},
    });
  }
}
