import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isBase64 } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { E2EE_MAX_ENVELOPE_CHARS, E2EE_MAX_GROUP_MEMBERS } from '../config/env';
import { signedFileUrl } from '../uploads/file-urls';
import { GroupEvents } from './group-events';
import { UpdateGroupDto } from './dto/update-group.dto';
import { SharedKind, SHARED_PAGE } from './dto/shared-query.dto';

const WITH_RELATIONS = {
  sender:    { select: { id: true, username: true, displayName: true, avatar: true } },
  reactions: true,
};

const PARTNER_SELECT = { id: true, username: true, displayName: true, avatar: true, bio: true, status: true };

// A message id arrives from a client, and an edit or a delete is only ever
// allowed against a row the database actually has.
function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

const LAST_MESSAGE_SELECT = {
  type: true,
  text: true,
  fileName: true,
  createdAt: true,
  sender: { select: { id: true, username: true, displayName: true } },
};

// The preview line of a chat is the newest message the reader can actually see:
// not one they deleted for themselves, not one that is now a tombstone.
const lastMessageInclude = (userId: string) => ({
  where:   { deletedAt: null, hides: { none: { userId } } },
  orderBy: { createdAt: 'desc' as const },
  take:    1,
  select:  LAST_MESSAGE_SELECT,
});

// A voice message is refused past a quarter of an hour. The upload ceiling of
// ten megabytes already bounds the bytes; this bounds the listening, and it is
// the number a recording client stops its own timer at.
const MAX_DURATION_MS = 15 * 60 * 1000;

// Photos and films in one list, documents and voice recordings in the other: the
// split a profile panel is judged by, not the enum's own vocabulary.
const SHARED_TYPES = {
  media: ['IMAGE', 'VIDEO'],
  files: ['FILE', 'AUDIO'],
} satisfies Record<'media' | 'files', ('IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO')[]>;

type LinkRow = {
  id:         string;
  text:       string;
  createdAt:  Date;
  senderId:   string;
  senderName: string;
};

// A link runs to the first space or quote, and the punctuation a sentence puts
// after it is trimmed back — a saved address ending in a full stop is an address
// that 404s.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}«»"'`]+$/;

function extractLinks(text: string) {
  return (text.match(URL_IN_TEXT) ?? []).map(raw => raw.replace(TRAILING_PUNCTUATION, '')).filter(Boolean);
}

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService, private events: GroupEvents) {}

  private findDirectConversation(userAId: string, userBId: string) {
    return this.prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
      },
    });
  }

  // Finds the 1-to-1 conversation between two users, creating it on first contact.
  private async getOrCreateDirectConversation(userAId: string, userBId: string) {
    const existing = await this.findDirectConversation(userAId, userBId);
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

  // One shape for every reader of a message: REST history, the send broadcast and
  // the edit/delete broadcasts all go through here, so a tombstone looks the same
  // wherever it is picked up. `deleted` is what the clients switch on; the raw
  // `deletedAt` never leaves the server, because the client only renders a
  // tombstone and must not sort or date it by a second clock.
  private toWireMessage(message: any) {
    const { reads, deletedAt, ...rest } = message;
    const deleted = Boolean(deletedAt);
    return {
      ...rest,
      deleted,
      editedAt: rest.editedAt ?? null,
      fileUrl: deleted ? null : signedFileUrl(rest.fileUrl),
      sender: rest.sender
        ? { ...rest.sender, avatar: signedFileUrl(rest.sender.avatar) }
        : rest.sender,
      read: reads.some(r => r.userId !== message.senderId),
    };
  }

  private toWirePreview(message: any) {
    if (!message) return null;
    return {
      type:      message.type,
      text:      message.text ?? null,
      fileName:  message.fileName ?? null,
      createdAt: message.createdAt,
      sender:    message.sender
        ? { id: message.sender.id, name: message.sender.displayName || message.sender.username }
        : null,
    };
  }

  private toWireGroup(group: any, unread = 0, lastMessage: any = null) {
    return {
      id:           group.id,
      name:         group.name,
      description:  group.description ?? null,
      e2ee:         group.e2ee,
      avatar:       signedFileUrl(group.avatar),
      createdAt:    group.createdAt,
      updatedAt:    group.updatedAt,
      participants: group.participants.map(p => ({
        ...p.user,
        avatar: signedFileUrl(p.user.avatar),
        role:   p.role,
      })),
      unread,
      lastMessage,
    };
  }

  async getConversation(myId: string, otherId: string, take = 50, skip = 0) {
    if (myId === otherId) throw new BadRequestException('نمی‌توانید با خودتان گفتگو کنید');
    const other = await this.prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
    if (!other) throw new NotFoundException('کاربر پیدا نشد');
    const conversation = await this.getOrCreateDirectConversation(myId, otherId);
    const messages = await this.prisma.message.findMany({
      // Deleted-for-everyone rows come back as tombstones so they keep their
      // place in the timeline; rows this reader hid for themselves do not, and
      // do not consume a page slot either.
      where:   { conversationId: conversation.id, hides: { none: { userId: myId } } },
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
        messages:     lastMessageInclude(myId),
      },
    });

    // A direct conversation can survive without its other participant (e.g.
    // after that account is deleted), so skip conversations with no partner
    // instead of returning an entry without a user.
    const withPartner = conversations.filter(c => c.participants[0]?.user);
    if (!withPartner.length) return [];

    const myRows = await this.prisma.conversationParticipant.findMany({
      where:  { userId: myId, conversationId: { in: withPartner.map(c => c.id) } },
      select: { conversationId: true, e2eeReadSeq: true },
    });
    const readSeq = new Map(myRows.map(row => [row.conversationId, row.e2eeReadSeq]));

    return Promise.all(withPartner.map(async (c) => {
      // An encrypted conversation has no plaintext rows to count, so unread is
      // "envelopes above my high-water mark that I did not submit". Controls are
      // not chat, so they never raise a badge.
      const unread = c.e2ee
        ? await this.prisma.e2eeEnvelope.count({
          where: {
            conversationId: c.id,
            senderId:       { not: myId },
            seq:            { gt: readSeq.get(c.id) ?? 0 },
            kind:           'MESSAGE',
          },
        })
        : await this.prisma.message.count({
          where: {
            conversationId: c.id,
            senderId:       { not: myId },
            reads:          { none: { userId: myId } },
            deletedAt:      null,
            hides:          { none: { userId: myId } },
          },
        });
      return {
        user:        c.participants[0].user,
        unread,
        e2ee:        c.e2ee,
        updatedAt:   c.updatedAt,
        // An encrypted transcript has no readable row to preview, and the chat
        // list is not allowed to carry message-shaped fields for it at all.
        ...(c.e2ee ? {} : { lastMessage: this.toWirePreview(c.messages[0]) }),
      };
    }));
  }

  async create(senderId: string, receiverId: string, data: {
    type?: string; text?: string; fileUrl?: string; fileName?: string; fileSize?: number; durationMs?: number;
  }) {
    const conversation = await this.getOrCreateDirectConversation(senderId, receiverId);
    return this.sendToConversation(conversation.id, senderId, data);
  }

  // Read receipts must never create conversations: only mark messages in an
  // existing direct chat as read.
  async markRead(senderId: string, receiverId: string) {
    const conversation = await this.findDirectConversation(senderId, receiverId);
    if (!conversation) return { count: 0, conversationId: null };
    const result = await this.markConversationRead(conversation.id, receiverId);
    return { ...result, conversationId: conversation.id };
  }

  // A reaction is a tapback, not a tally: one person holds at most one reaction
  // per message, so tapping the same emoji removes it, tapping another replaces
  // it, and the answer is the message's whole reaction list. Clients render that
  // list instead of adjusting a counter themselves, which is what let a number
  // grow past the number of people when the old event was replayed.
  async toggleReaction(messageId: string, userId: string, emoji: string) {
    const trimmedEmoji = typeof emoji === 'string' ? emoji.trim() : '';
    if (!messageId || typeof messageId !== 'string') {
      throw new BadRequestException('پیام نامعتبر است');
    }
    if (!trimmedEmoji || trimmedEmoji.length > 32) {
      throw new BadRequestException('ری‌اکشن نامعتبر است');
    }

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        conversationId: true,
        deletedAt:      true,
        hides:          { where: { userId }, select: { id: true } },
      },
    });
    // A tombstone carries no reactions and a row you hid is not on your screen
    // to react to, so both answer the same way a missing id does.
    if (!message || message.deletedAt || message.hides.length) throw new NotFoundException('پیام پیدا نشد');

    // Authorization is based on the message's real conversation, never on an
    // ID supplied by the client.
    await this.assertMember(message.conversationId, userId);

    const reactions = await this.prisma.$transaction(async (tx) => {
      const mine = await tx.reaction.findUnique({
        where: { userId_messageId: { userId, messageId } },
        select: { id: true, emoji: true },
      });

      if (mine?.emoji === trimmedEmoji) {
        await tx.reaction.delete({ where: { id: mine.id } });
      } else if (mine) {
        await tx.reaction.update({ where: { id: mine.id }, data: { emoji: trimmedEmoji } });
      } else {
        // Upsert rather than create: two taps that raced past the read above
        // must still leave one row, which is the whole rule.
        await tx.reaction.upsert({
          where:  { userId_messageId: { userId, messageId } },
          create: { messageId, userId, emoji: trimmedEmoji },
          update: { emoji: trimmedEmoji },
        });
      }

      return tx.reaction.findMany({
        where:  { messageId },
        select: { id: true, userId: true, emoji: true },
        orderBy: { createdAt: 'asc' },
      });
    });

    return { messageId, conversationId: message.conversationId, reactions };
  }

  // ── Group chat ───────────────────────────────────────────────────────

  // One rule for both paths: renaming a group must never be able to produce
  // a name the create path would have refused.
  private assertGroupName(name: string) {
    const trimmed = name?.trim();
    if (!trimmed || trimmed.length < 2) {
      throw new BadRequestException('نام گروه باید حداقل ۲ کاراکتر باشد');
    }
    if (trimmed.length > 60) {
      throw new BadRequestException('نام گروه نباید بیشتر از ۶۰ کاراکتر باشد');
    }
    return trimmed;
  }

  // One insert for both group kinds: they differ only in whether the
  // conversation accepts envelopes from its first byte, and in how many members
  // an encrypted one may carry.
  async createGroup(
    creatorId: string,
    name: string,
    memberIds: string[],
    options: { e2ee?: boolean; memberCap?: number } = {},
  ) {
    const trimmedName = this.assertGroupName(name);

    const uniqueMembers = [...new Set([creatorId, ...memberIds])];
    if (uniqueMembers.length < 2) {
      throw new BadRequestException('حداقل یک عضو دیگر انتخاب کنید');
    }
    // The cap is what keeps the Welcome that opens an encrypted group inside one
    // envelope: every device of every member goes into that single message.
    if (options.memberCap && uniqueMembers.length > options.memberCap) {
      throw new BadRequestException(`حداکثر ${options.memberCap} عضو برای یک گروه رمزنگاری‌شده مجاز است`);
    }

    const existing = await this.prisma.user.findMany({
      where:  { id: { in: uniqueMembers } },
      select: { id: true },
    });
    if (existing.length !== uniqueMembers.length) {
      throw new BadRequestException('یکی از اعضای انتخاب‌شده معتبر نیست');
    }

    const group = await this.prisma.conversation.create({
      data: {
        isGroup: true,
        e2ee:    options.e2ee ?? false,
        name:    trimmedName,
        participants: {
          create: uniqueMembers.map(userId => ({
            userId,
            role: userId === creatorId ? 'OWNER' : 'MEMBER',
          })),
        },
      },
      include: { participants: { include: { user: { select: PARTNER_SELECT } } } },
    });
    return this.toWireGroup(group);
  }

  async listGroups(myId: string) {
    const groups = await this.prisma.conversation.findMany({
      where:   { isGroup: true, participants: { some: { userId: myId } } },
      orderBy: { updatedAt: 'desc' },
      include: {
        participants: { include: { user: { select: PARTNER_SELECT } } },
        messages:     lastMessageInclude(myId),
      },
    });
    if (!groups.length) return [];

    const myRows = await this.prisma.conversationParticipant.findMany({
      where:  { userId: myId, conversationId: { in: groups.map(group => group.id) } },
      select: { conversationId: true, e2eeReadSeq: true },
    });
    const readSeq = new Map(myRows.map(row => [row.conversationId, row.e2eeReadSeq]));

    return Promise.all(groups.map(async (group) => {
      // An encrypted group keeps no plaintext rows, so its badge counts what the
      // high-water mark has not covered yet instead of counting messages.
      const unread = group.e2ee
        ? await this.prisma.e2eeEnvelope.count({
          where: {
            conversationId: group.id,
            senderId:       { not: myId },
            seq:            { gt: readSeq.get(group.id) ?? 0 },
            kind:           'MESSAGE',
          },
        })
        : await this.prisma.message.count({
          where: {
            conversationId: group.id,
            senderId:       { not: myId },
            reads:          { none: { userId: myId } },
            deletedAt:      null,
            hides:          { none: { userId: myId } },
          },
        });
      return this.toWireGroup(group, unread, this.toWirePreview(group.messages[0]));
    }));
  }

  // A group that is encrypted from its first byte. The client builds the MLS
  // group before it calls this and refuses the create when the Welcome would not
  // fit one envelope, so a conversation never exists in a state nobody can open.
  createEncryptedGroup(creatorId: string, name: string, memberIds: string[]) {
    return this.createGroup(creatorId, name, memberIds, {
      e2ee:       true,
      memberCap:  E2EE_MAX_GROUP_MEMBERS,
    });
  }

  // Group identity is server metadata, so an encrypted group can be renamed
  // and given a photo or a bio: none of it is message content, and every
  // member already sees the name in their chat list.
  //
  // The recency stamp is deliberately carried over. The chat list is ordered
  // by updatedAt, and editing a profile is not a new message — without this
  // a rename would float an old group to the top of every member’s list.
  async updateGroup(conversationId: string, requesterId: string, dto: UpdateGroupDto) {
    const membership = await this.assertMember(conversationId, requesterId);
    if (membership.role === 'MEMBER') {
      throw new ForbiddenException('فقط مالک یا ادمین می‌تواند اطلاعات گروه را تغییر دهد');
    }

    const current = await this.prisma.conversation.findFirst({
      where:  { id: conversationId, isGroup: true },
      select: { id: true, name: true, avatar: true, description: true, updatedAt: true },
    });
    if (!current) throw new NotFoundException('گروه پیدا نشد');

    if (dto.name === undefined && dto.description === undefined && dto.avatar === undefined) {
      throw new BadRequestException('هیچ تغییری برای این گروه ارسال نشده است');
    }

    const data: { name?: string; description?: string | null; avatar?: string | null } = {};
    if (dto.name !== undefined) data.name = this.assertGroupName(dto.name);
    if (dto.description !== undefined) data.description = dto.description || null;
    if (dto.avatar !== undefined) data.avatar = dto.avatar || null;

    // Prisma stamps @updatedAt whatever it is handed, so the old value goes back
    // in the same transaction. A concurrent message waits on the row lock and
    // then stamps its own time, which is the ordering we actually want.
    // The stamp is passed as a naive UTC string because a Date bound into raw SQL
    // is formatted in the server's local zone and this column stores UTC wall time.
    const stamp = current.updatedAt.toISOString().replace('T', ' ').replace('Z', '');
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id: conversationId }, data });
      await tx.$executeRaw`UPDATE conversations SET "updatedAt" = ${stamp}::timestamp WHERE id = ${conversationId}`;
    });

    const group = await this.prisma.conversation.findUnique({
      where:  { id: conversationId },
      include: { participants: { include: { user: { select: PARTNER_SELECT } } } },
    });
    const wire = this.toWireGroup(group);
    this.events.publishGroupUpdated({
      memberIds: group.participants.map((p) => p.userId),
      group: wire,
    });
    return wire;
  }

  // Membership is an MLS commit, not a database row: adding or removing a leaf
  // without a new epoch would leave the new member unable to decrypt, and a
  // removed member still holding the old keys. Until that rekey path exists,
  // the server refuses the half-change instead of creating a group that only
  // looks shared.
  private async assertMembershipEditable(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where:  { id: conversationId },
      select: { e2ee: true },
    });
    if (conversation?.e2ee) {
      throw new BadRequestException('اعضای گروه رمزنگاری‌شده فعلاً قابل تغییر نیستند');
    }
  }

  async addParticipant(conversationId: string, requesterId: string, userId: string) {
    const requester = await this.assertMember(conversationId, requesterId);
    if (requester.role === 'MEMBER') throw new ForbiddenException('فقط مالک یا ادمین می‌تواند عضو اضافه کند');
    await this.assertMembershipEditable(conversationId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('کاربر پیدا نشد');
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
    await this.assertMembershipEditable(conversationId);
    return this.prisma.conversationParticipant.delete({
      where: { conversationId_userId: { conversationId, userId } },
    });
  }

  async getConversationMessages(conversationId: string, userId: string, take = 50, skip = 0) {
    await this.assertMember(conversationId, userId);
    const messages = await this.prisma.message.findMany({
      where:   { conversationId, hides: { none: { userId } } },
      include: { ...WITH_RELATIONS, reads: { select: { userId: true } } },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
    return messages.reverse().map(m => this.toWireMessage(m));
  }

  private async resolveSharedTarget(target: string, requesterId: string) {
    const asConversation = await this.prisma.conversation.findUnique({
      where:  { id: target },
      select: { id: true, e2ee: true },
    });
    if (asConversation) {
      await this.assertMember(asConversation.id, requesterId);
      return asConversation;
    }

    // Not a conversation id, so it is the other way a client names a chat: the
    // peer on the other end. A chat that does not exist has nothing to show, and
    // that is also the answer for a peer that does not exist, so probing this
    // endpoint cannot list accounts.
    const direct = await this.findDirectConversation(requesterId, target);
    if (!direct) throw new NotFoundException('گفتگو پیدا نشد');
    return { id: direct.id, e2ee: direct.e2ee };
  }

  // The photos, files and links a chat's profile shows. `target` is either a
  // group's conversation id or a peer's user id — the two ways the clients
  // already address a chat — and neither is trusted: membership in whatever it
  // resolves to is what authorizes the read.
  //
  // An encrypted conversation has no readable rows to list, so the answer says
  // so rather than returning an empty list, which a client would render as "this
  // chat has no photos" for a chat that has thousands of them.
  async sharedItems(
    target: string,
    requesterId: string,
    kind: SharedKind,
    take = SHARED_PAGE,
    before?: string,
  ) {
    const conversation = await this.resolveSharedTarget(target, requesterId);
    if (conversation.e2ee) return { kind, encrypted: true, items: [], nextCursor: null };

    const cursor = before ? new Date(before) : null;

    if (kind === 'links') {
      // Which messages carry a link is a question about the text, so it is asked
      // of the database rather than answered by paging through every message.
      // A JS Date bound into raw SQL is written in the server's local zone while
      // these columns hold naive UTC, so the cursor goes in as a UTC wall time.
      const older = cursor
        ? Prisma.sql`AND m."createdAt" < ${cursor.toISOString().replace('T', ' ').replace('Z', '')}::timestamp`
        : Prisma.empty;
      const rows = await this.prisma.$queryRaw<LinkRow[]>(Prisma.sql`
        SELECT m.id, m.text, m."createdAt", m."senderId",
               COALESCE(NULLIF(u."displayName", ''), u.username) AS "senderName"
        FROM messages m
        JOIN users u ON u.id = m."senderId"
        WHERE m."conversationId" = ${conversation.id}
          AND m."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM message_hides h
            WHERE h."messageId" = m.id AND h."userId" = ${requesterId}
          )
          AND m.type = 'TEXT'
          AND m.text ~ 'https?://'
          ${older}
        ORDER BY m."createdAt" DESC, m.id DESC
        LIMIT ${take + 1}
      `);

      // The page boundary is a message, never a link inside one, so a message
      // with several links returns all of them and none of them are skipped.
      const hasMore = rows.length > take;
      const items = rows.slice(0, take).flatMap(row => extractLinks(row.text).map((url, index) => ({
        id:        `${row.id}-${index}`,
        kind:      'link',
        url,
        text:      row.text,
        createdAt: row.createdAt,
        sender:    { id: row.senderId, name: row.senderName },
      })));
      return { kind, encrypted: false, items, nextCursor: hasMore ? rows[take - 1].createdAt.toISOString() : null };
    }

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        deletedAt:      null,
        hides:          { none: { userId: requesterId } },
        type:           { in: SHARED_TYPES[kind] },
        ...(cursor ? { createdAt: { lt: cursor } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take:    take + 1,
      select:  {
        id: true, type: true, fileUrl: true, fileName: true, fileSize: true, createdAt: true,
        sender: { select: { id: true, username: true, displayName: true } },
      },
    });

    const hasMore = rows.length > take;
    return {
      kind,
      encrypted: false,
      items: rows.slice(0, take).map(row => ({
        id:        row.id,
        kind,
        type:      row.type.toLowerCase(),
        url:       signedFileUrl(row.fileUrl),
        name:      row.fileName,
        size:      row.fileSize,
        createdAt: row.createdAt,
        sender:    { id: row.sender.id, name: row.sender.displayName || row.sender.username },
      })),
      nextCursor: hasMore ? rows[take - 1].createdAt.toISOString() : null,
    };
  }

  private normalizeOutgoingMessage(data: {
    type?: string; text?: string; fileUrl?: string; fileName?: string; fileSize?: number; durationMs?: number;
  }) {
    const type = (typeof data.type === 'string' ? data.type : 'TEXT').toUpperCase();
    const allowedTypes = ['TEXT', 'IMAGE', 'FILE', 'AUDIO', 'VIDEO'];
    if (!allowedTypes.includes(type)) throw new BadRequestException('نوع پیام نامعتبر است');

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (text.length > 4000) throw new BadRequestException('متن پیام بیش از حد طولانی است');

    if (type === 'TEXT') {
      if (!text) throw new BadRequestException('متن پیام نمی‌تواند خالی باشد');
      return { type: type as any, text, fileUrl: null, fileName: null, fileSize: null, durationMs: null };
    }

    const fileUrl = typeof data.fileUrl === 'string' ? data.fileUrl.trim() : '';
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(fileUrl)) {
      throw new BadRequestException('فایل پیوست نامعتبر است');
    }

    const fileName = typeof data.fileName === 'string' ? data.fileName.trim().slice(0, 255) : null;
    if (data.fileSize !== undefined && (!Number.isInteger(data.fileSize) || data.fileSize < 0 || data.fileSize > 10 * 1024 * 1024)) {
      throw new BadRequestException('حجم فایل نامعتبر است');
    }

    // A refused duration is always the better answer than a stored one nobody
    // can play: a voice bubble counts down from this number, so a length that
    // never ends, or has no length at all, is a bubble that lies about its file.
    const durationMs = data.durationMs ?? null;
    if (durationMs !== null && (!Number.isInteger(durationMs)
      || durationMs < 0 || durationMs > MAX_DURATION_MS)) {
      throw new BadRequestException('مدت پیام نامعتبر است');
    }
    // Only media that plays has a length worth keeping. A picture or a plain
    // file drops the field rather than storing a number nothing will show.
    const plays = type === 'AUDIO' || type === 'VIDEO';

    return {
      type: type as any,
      text: text || null,
      fileUrl,
      fileName,
      fileSize: data.fileSize ?? null,
      durationMs: plays ? durationMs : null,
    };
  }

  async sendToConversation(conversationId: string, senderId: string, data: {
    type?: string; text?: string; fileUrl?: string; fileName?: string; fileSize?: number; durationMs?: number;
  }) {
    await this.assertMember(conversationId, senderId);
    // An encrypted conversation has no plaintext path: accepting one here would
    // be a silent downgrade the recipients cannot see coming.
    const conversation = await this.prisma.conversation.findUnique({
      where:  { id: conversationId },
      select: { e2ee: true },
    });
    if (conversation?.e2ee) {
      throw new BadRequestException('این گفتگو فقط بسته رمزنگاری‌شده می‌پذیرد');
    }
    const normalized = this.normalizeOutgoingMessage(data);
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        senderId,
        ...normalized,
      },
      include: { ...WITH_RELATIONS, reads: { select: { userId: true } } },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  { updatedAt: new Date() },
    });
    return this.toWireMessage(message);
  }

  // ── Edit and delete a stored message ──────────────────────────────────────
  //
  // Both paths derive the conversation from the row rather than from anything
  // the client sends, so naming a message id is never enough to act inside a
  // chat the caller is not a member of. Neither one touches the conversation's
  // recency stamp: an action on a past message is not new activity, and it must
  // not reorder the chat list.

  // Text-only, sender-only, and never inside an encrypted chat: a plaintext
  // rewrite there would be a new readable row in a conversation that is
  // ciphertext-only from its first envelope.
  async editMessage(messageId: string, userId: string, text: unknown) {
    if (!isMessageId(messageId)) throw new BadRequestException('پیام نامعتبر است');

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        conversationId: true,
        senderId:       true,
        type:           true,
        deletedAt:      true,
        hides:          { where: { userId }, select: { id: true } },
        conversation:   { select: { e2ee: true } },
      },
    });
    if (!message || message.deletedAt || message.hides.length) throw new NotFoundException('پیام پیدا نشد');
    await this.assertMember(message.conversationId, userId);
    if (message.senderId !== userId) throw new ForbiddenException('فقط فرستنده می‌تواند پیامش را ویرایش کند');
    if (message.type !== 'TEXT') throw new BadRequestException('فقط پیام متنی قابل ویرایش است');
    if (message.conversation.e2ee) {
      throw new BadRequestException('پیام این گفتگو رمزنگاری‌شده است و از این راه ویرایش نمی‌شود');
    }

    // The same normalization that guards sending: one limit for one kind of text,
    // so an edit can never grow a message past what a new one would be allowed.
    // Anything that is not a string arrives as the empty one and is refused.
    const { text: editedText } = this.normalizeOutgoingMessage({
      type: 'TEXT',
      text: typeof text === 'string' ? text : '',
    });

    const updated = await this.prisma.message.update({
      where:   { id: messageId },
      data:    { text: editedText, editedAt: new Date() },
      include: { ...WITH_RELATIONS, reads: { select: { userId: true } } },
    });
    return this.toWireMessage(updated);
  }

  // `everyone` empties the row for every participant; `me` leaves the row intact
  // for everyone else and only records that this viewer does not want to see it.
  async deleteMessage(messageId: string, userId: string, scope: 'everyone' | 'me') {
    if (!isMessageId(messageId)) throw new BadRequestException('پیام نامعتبر است');

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        conversationId: true,
        senderId:       true,
        deletedAt:      true,
        hides:          { where: { userId }, select: { id: true } },
      },
    });
    if (!message || message.deletedAt) throw new NotFoundException('پیام پیدا نشد');
    await this.assertMember(message.conversationId, userId);

    if (scope === 'everyone') {
      // A row this viewer already hid is not on their screen to delete, so it
      // answers like a row that is not there. Hiding it again is not an error:
      // the upsert below is what makes a retried "delete for me" harmless.
      if (message.hides.length) throw new NotFoundException('پیام پیدا نشد');
      if (message.senderId !== userId) {
        throw new ForbiddenException('فقط فرستنده می‌تواند پیام را برای همه حذف کند');
      }
      // One transaction, because a tombstone that still shows the old text, the
      // old file or the reactions it collected is three bugs at once.
      await this.prisma.$transaction(async tx => {
        await tx.message.update({
          where: { id: messageId },
          data:  { deletedAt: new Date(), text: null, fileUrl: null, fileName: null, fileSize: null, durationMs: null },
        });
        await tx.reaction.deleteMany({ where: { messageId } });
        await tx.messageRead.deleteMany({ where: { messageId } });
      });
    } else {
      await this.prisma.messageHide.upsert({
        where:  { messageId_userId: { messageId, userId } },
        create: { messageId, userId },
        update: {},
      });
    }

    return { messageId, conversationId: message.conversationId, scope };
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

  // ── End-to-end encrypted conversations ───────────────────────────────────

  /**
   * Opt a direct chat into E2EE. Idempotent and one-way: enabling never turns
   * off, and the plaintext rows that already exist stay where they are so the
   * client can label them "sent before encryption" instead of hiding them.
   */
  async enableDirectE2ee(myId: string, otherId: string) {
    if (myId === otherId) throw new BadRequestException('نمی‌توانید با خودتان گفتگو کنید');
    const other = await this.prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
    if (!other) throw new NotFoundException('کاربر پیدا نشد');

    const conversation = await this.getOrCreateDirectConversation(myId, otherId);
    if (!conversation.e2ee) {
      await this.prisma.conversation.update({ where: { id: conversation.id }, data: { e2ee: true } });
    }
    return { conversationId: conversation.id, e2ee: true };
  }

  // Read-only look-up a client uses when it opens a chat, so it can choose the
  // encrypted path without creating or changing anything.
  async directE2eeState(myId: string, otherId: string) {
    const conversation = await this.findDirectConversation(myId, otherId);
    return { conversationId: conversation?.id ?? null, e2ee: conversation?.e2ee ?? false };
  }

  // The group half of the same probe. Scoped to conversations the caller
  // participates in, so somebody else's group id answers exactly like an id that
  // does not exist — no hint about which groups are encrypted.
  async groupE2eeState(myId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where:  { id: conversationId, isGroup: true, participants: { some: { userId: myId } } },
      select: { id: true, e2ee: true },
    });
    return { conversationId: conversation?.id ?? null, e2ee: conversation?.e2ee ?? false };
  }

  /**
   * Store one opaque MLS message at the next sequence number of an encrypted
   * conversation. The caller in the gateway emits it inside the same
   * per-conversation critical section: MLS rejects a message whose ratchet
   * generation it has not seen yet, so assignment and delivery must not
   * interleave.
   */
  async appendE2eeEnvelope(conversationId: string, senderId: string, content: string) {
    // Format checks first: they say nothing about the conversation, so they
    // cannot leak whether an id belongs to someone else.
    if (typeof content !== 'string' || !content.length) throw new BadRequestException('بسته خالی است');
    if (content.length > E2EE_MAX_ENVELOPE_CHARS) throw new BadRequestException('بسته بیش از حد بزرگ است');
    // Format only. The server can say "this is not bytes"; it cannot say
    // "this is a valid MLS message", and it does not try to.
    if (!isBase64(content)) throw new BadRequestException('بسته باید base64 باشد');

    // Membership before conversation state: an outsider must not learn whether
    // a conversation id they guessed is encrypted or still plaintext.
    await this.assertMember(conversationId, senderId);

    const conversation = await this.prisma.conversation.findUnique({
      where:  { id: conversationId },
      select: { e2ee: true },
    });
    if (!conversation.e2ee) throw new BadRequestException('این گفتگو رمزنگاری سرتاسری ندارد');

    const [envelope] = await this.prisma.$transaction(async tx => {
      // Transaction-scoped advisory lock: sequence assignment stays gapless
      // even if a second API process appends at the same moment. The unique
      // (conversationId, seq) index is the backstop if that assumption breaks.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))`;
      const last = await tx.e2eeEnvelope.findFirst({
        where:   { conversationId },
        orderBy: { seq: 'desc' },
        select:  { seq: true },
      });
      const created = await tx.e2eeEnvelope.create({
        data: { conversationId, senderId, seq: (last?.seq ?? 0) + 1, content },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      return [created];
    });

    return {
      id:             envelope.id,
      conversationId,
      seq:            envelope.seq,
      senderId,
      content:        envelope.content,
      createdAt:      envelope.createdAt,
    };
  }

  // Catch-up read: a client that reconnects pulls everything above the last
  // sequence number it processed, in order, and feeds it to MLS one by one.
  async listE2eeEnvelopes(conversationId: string, userId: string, afterSeq: number, take: number) {
    await this.assertMember(conversationId, userId);
    return this.prisma.e2eeEnvelope.findMany({
      where:   { conversationId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take,
      select:  { id: true, seq: true, senderId: true, content: true, createdAt: true },
    });
  }

  /**
   * Move a participant's read mark forward. Only forward: a replayed or late
   * receipt must not rewind their unread count.
   */
  async markE2eeRead(conversationId: string, userId: string, upToSeq: number) {
    const membership = await this.assertMember(conversationId, userId);
    if (!(upToSeq > membership.e2eeReadSeq)) return { count: 0 };
    await this.prisma.conversationParticipant.update({
      where: { id: membership.id },
      data:  { e2eeReadSeq: upToSeq },
    });
    return { count: 1 };
  }
}
