import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { E2EE_ENVELOPE_PAGE } from '../config/env';
import { MessagesService } from './messages.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { AddParticipantDto } from './dto/add-participant.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { SharedQueryDto } from './dto/shared-query.dto';
import { DirectPeerDto } from './dto/direct-peer.dto';
import { EnvelopeQueryDto } from './dto/envelope-query.dto';

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private messages: MessagesService, private users: UsersService) {}

  // List of people the current user has actually exchanged messages with
  // (new accounts start with an empty list — no "default" chats).
  @Get('conversations')
  async listConversations(@Request() req) {
    const list  = await this.messages.listConversations(req.user.id);
    const users = await this.users.withOnlineStatus(list.map(c => c.user));
    return list.map((c, i) => ({
      user:      users[i],
      unread:    c.unread,
      e2ee:      c.e2ee,
      updatedAt: c.updatedAt,
      ...(c.e2ee ? {} : { lastMessage: c.lastMessage ?? null }),
    }));
  }

  // ── Group chats ──────────────────────────────────────
  @Get('groups')
  listGroups(@Request() req) {
    return this.messages.listGroups(req.user.id);
  }

  @Post('groups')
  createGroup(@Request() req, @Body() dto: CreateGroupDto) {
    return this.messages.createGroup(req.user.id, dto.name, dto.memberIds);
  }

  // Group identity is server metadata even for an encrypted group — name, photo
  // and bio are what every member's chat row already shows — so editing them
  // never touches the ciphertext stream. Owner and admins only; members are told
  // over the socket.
  @Patch('groups/:conversationId')
  updateGroup(
    @Request()                          req,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body()                             dto: UpdateGroupDto,
  ) {
    return this.messages.updateGroup(conversationId, req.user.id, dto);
  }

  @Get('groups/:conversationId')
  getGroupMessages(
    @Request()                       req,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query()                         query: PaginationQueryDto,
  ) {
    return this.messages.getConversationMessages(
      conversationId, req.user.id,
      query.take ?? 50,
      query.skip ?? 0,
    );
  }

  // What a chat's profile lists as its media, files and links. Addressed by a
  // group's conversation id or by a peer's user id, because those are the two
  // ways the clients already name a chat.
  @Get('shared/:target')
  sharedItems(
    @Request()                    req,
    @Param('target', ParseUUIDPipe) target: string,
    @Query()                      query: SharedQueryDto,
  ) {
    return this.messages.sharedItems(target, req.user.id, query.kind, query.take, query.before);
  }

  @Post('groups/:conversationId/participants')
  addParticipant(
    @Request()                       req,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body()                          dto: AddParticipantDto,
  ) {
    return this.messages.addParticipant(conversationId, req.user.id, dto.userId);
  }

  @Delete('groups/:conversationId/participants/:userId')
  removeParticipant(
    @Request()                       req,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('userId', ParseUUIDPipe)  userId: string,
  ) {
    return this.messages.removeParticipant(conversationId, req.user.id, userId);
  }

  // ── Encrypted direct conversations ───────────────────────────
  // Opt-in, idempotent, and one-way: a client calls this before it builds its
  // MLS group. Nothing here turns encryption back off, so a downgrade can only
  // ever be a visible user action, never something the transport does silently.
  @Post('e2ee/direct')
  enableDirectE2ee(@Request() req, @Body() dto: DirectPeerDto) {
    return this.messages.enableDirectE2ee(req.user.id, dto.userId);
  }

  // Does a direct conversation already exist, and is it encrypted? Read-only:
  // a client probing this must not create or flip anything.
  @Get('e2ee/direct/:userId')
  directE2eeState(@Request() req, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.messages.directE2eeState(req.user.id, userId);
  }

  // A group that is encrypted from its first message. Same rule as the direct
  // opt-in: the flag is set once, never taken back off, and the client has
  // already built the MLS group whose Welcome it is about to publish.
  @Post('e2ee/group')
  createEncryptedGroup(@Request() req, @Body() dto: CreateGroupDto) {
    return this.messages.createEncryptedGroup(req.user.id, dto.name, dto.memberIds);
  }

  @Get('e2ee/group/:conversationId')
  groupE2eeState(@Request() req, @Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.messages.groupE2eeState(req.user.id, conversationId);
  }

  // Opaque MLS envelopes in delivery order, for a client catching up after a
  // reconnect. Returns exactly what was stored, byte for byte, and proves
  // nothing about it.
  @Get(':conversationId/envelopes')
  listEnvelopes(
    @Request()                          req,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query()                            query: EnvelopeQueryDto,
  ) {
    return this.messages.listE2eeEnvelopes(
      conversationId,
      req.user.id,
      query.afterSeq ?? 0,
      query.take ?? E2EE_ENVELOPE_PAGE,
    );
  }

  // ── Direct (1-to-1) chat ─────────────────────────────
  @Get(':userId')
  getConversation(
    @Request()                      req,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query()                        query: PaginationQueryDto,
  ) {
    return this.messages.getConversation(
      req.user.id, userId,
      query.take ?? 50,
      query.skip ?? 0,
    );
  }
}
