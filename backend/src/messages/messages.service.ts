import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const WITH_RELATIONS = {
  sender:    { select: { id: true, username: true, displayName: true, avatar: true } },
  reactions: true,
};

const PARTNER_SELECT = { id: true, username: true, displayName: true, avatar: true, bio: true, status: true };

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  // Finds the 1-to-1 conversation between two users, creating it on first contact.
  private async getOrCreateDirectConversation(userAId: string, userBId: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
      },
    });
    if (existing) return existing;

    return this.prisma.conversation.create({
      data: {
        isGroup:      false,
        participants: { create: [{ userId: userAId }, { userId: userBId }] },
      },
    });
  }

  private async assertMember(conversationId: string, userId: string) {
    const membership = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!membership) throw new ForbiddenException('شما عضو این گفتگو نیستید');
    return membership;
  }

  private toWireMessage(message: any) {
    const { reads, ...rest } = message;
    return { ...rest, read: reads.some(r => r.userId !== message.senderId) };
  }

  async getConversation(myId: string, otherId: string, take = 50, skip = 0) {
    const conversation = await this.getOrCreateDirectConversation(myId, otherId);
    const messages = await this.prisma.message.findMany({
      where:   { conversationId: conversation.id, deletedAt: null },
      include: { ...WITH_RELATIONS, reads: { select: { userId: true } } },
      // Newest first so take/skip pagination starts from recent messages,
      // then flip back to chronological order for the UI.
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
    return messages.reverse().map(m => this.toWireMessage(m));
  }

  // Builds the user's direct-message list: every 1-to-1 conversation they're
  // part of, ordered by most recent activity, with an unread count.
  async listConversations(myId: string) {
    const conversations = await this.prisma.conversation.findMany({
      where:   { isGroup: false, participants: { some: { userId: myId } } },
      orderBy: { updatedAt: 'desc' },
      include: {
        participants: { where: { userId: { not: myId } }, include: { user: { select: PARTNER_SELECT } } },
      },
    });

    // A direct conversation can survive without its other participant (e.g.
    // after that account is deleted), so skip conversations with no partner
    // instead of returning an entry without a user.
    const withPartner = conversations.filter(c => c.participants[0]?.user);

    return Promise.all(withPartner.map(async (c) => {
      const unread = await this.prisma.message.count({
        where: { conversationId: c.id, senderId: { not: myId }, reads: { none: { userId: myId } } },
      });
      return { user: c.participants[0].user, unread, updatedAt: c.updatedAt };
    }));
  }

  async create(senderId: string, receiverId: string, data: {
    type?: string; text?: string; fileUrl?: string; fileName?: string; fileSize?: number;
  }) {
    const conversation = await this.getOrCreateDirectConversation(senderId, receiverId);
    return this.sendToConversation(conversation.id, senderId, data);
  }

  async markRead(senderId: string, receiverId: string) {
    const conversation = await this.getOrCreateDirectConversation(senderId, receiverId);
    const result = await this.markConversationRead(conversation.id, receiverId);
    return { ...result, conversationId: conversation.id };
  }

  async addReaction(messageId: string, userId: string, emoji: string) {
    return this.prisma.reaction.upsert({
      where:  { userId_messageId_emoji: { userId, messageId, emoji } },
      create: { messageId, userId, emoji },
      update: {},
    });
  }

  // ── Group chat ───────────────────────────────────────────────────────

  async createGroup(creatorId: string, name: string, memberIds: string[]) {
    const trimmedName = name?.trim();
    if (!trimmedName || trimmedName.length < 2) {
      throw new BadRequestException('نام گروه باید حداقل ۲ کاراکتر باشد');
    }
    if (trimmedName.length > 60) {
      throw new BadRequestException('نام گروه نباید بیشتر از ۶۰ کاراکتر باشد');
    }

    const uniqueMembers = [...new Set([creatorId, ...memberIds])];
    if (uniqueMembers.length < 2) {
      throw new BadRequestException('حداقل یک عضو دیگر انتخاب کنید');
    }

    const existing = await this.prisma.user.findMany({
      where:  { id: { in: uniqueMembers } },
      select: { id: true },
    });
    if (existing.length !== uniqueMembers.length) {
      throw new BadRequestException('یکی از اعضای انتخاب‌شده معتبر نیست');
    }

    return this.prisma.conversation.create({
      data: {
        isGroup: true,
        name: trimmedName,
        participants: {
          create: uniqueMembers.map(userId => ({
            userId,
            role: userId === creatorId ? 'OWNER' : 'MEMBER',
          })),
        },
      },
      include: { participants: { include: { user: { select: PARTNER_SELECT } } } },
    });
  }

  async listGroups(myId: string) {
    const groups = await this.prisma.conversation.findMany({
      where:   { isGroup: true, participants: { some: { userId: myId } } },
      orderBy: { updatedAt: 'desc' },
      include: { participants: { include: { user: { select: PARTNER_SELECT } } } },
    });

    return Promise.all(groups.map(async (group) => {
      const unread = await this.prisma.message.count({
        where: { conversationId: group.id, senderId: { not: myId }, reads: { none: { userId: myId } } },
      });
      return {
        id:           group.id,
        name:         group.name,
        avatar:       group.avatar,
        createdAt:    group.createdAt,
        updatedAt:    group.updatedAt,
        participants: group.participants.map(p => ({ ...p.user, role: p.role })),
        unread,
      };
    }));
  }

  async addParticipant(conversationId: string, requesterId: string, userId: string) {
    const requester = await this.assertMember(conversationId, requesterId);
    if (requester.role === 'MEMBER') throw new ForbiddenException('فقط مالک یا ادمین می‌تواند عضو اضافه کند');
    return this.prisma.conversationParticipant.upsert({
      where:  { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId, role: 'MEMBER' },
      update: {},
    });
  }

  async removeParticipant(conversationId: string, requesterId: string, userId: string) {
    const requester = await this.assertMember(conversationId, requesterId);
    if (requester.role === 'MEMBER' && requesterId !== userId) {
      throw new ForbiddenException('فقط مالک یا ادمین می‌تواند عضو حذف کند');
    }
    return this.prisma.conversationParticipant.delete({
      where: { conversationId_userId: { conversationId, userId } },
    });
  }

  async getConversationMessages(conversationId: string, userId: string, take = 50, skip = 0) {
    await this.assertMember(conversationId, userId);
    const messages = await this.prisma.message.findMany({
      where:   { conversationId, deletedAt: null },
      include: { ...WITH_RELATIONS, reads: { select: { userId: true } } },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
    return messages.reverse().map(m => this.toWireMessage(m));
  }

  async sendToConversation(conversationId: string, senderId: string, data: {
    type?: string; text?: string; fileUrl?: string; fileName?: string; fileSize?: number;
  }) {
    await this.assertMember(conversationId, senderId);
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        senderId,
        type:     (data.type as any) ?? 'TEXT',
        text:     data.text,
        fileUrl:  data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
      },
      include: { ...WITH_RELATIONS, reads: { select: { userId: true } } },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  { updatedAt: new Date() },
    });
    return this.toWireMessage(message);
  }

  async markConversationRead(conversationId: string, userId: string) {
    await this.assertMember(conversationId, userId);
    const unread = await this.prisma.message.findMany({
      where:  { conversationId, senderId: { not: userId }, reads: { none: { userId } } },
      select: { id: true },
    });
    if (!unread.length) return { count: 0 };
    await this.prisma.messageRead.createMany({
      data:           unread.map(m => ({ messageId: m.id, userId })),
      skipDuplicates: true,
    });
    return { count: unread.length };
  }

  getConversationParticipantIds(conversationId: string) {
    return this.prisma.conversationParticipant.findMany({
      where:  { conversationId },
      select: { userId: true },
    }).then(rows => rows.map(r => r.userId));
  }

  getUserConversationIds(userId: string) {
    return this.prisma.conversationParticipant.findMany({
      where:  { userId },
      select: { conversationId: true },
    }).then(rows => rows.map(r => r.conversationId));
  }
}
