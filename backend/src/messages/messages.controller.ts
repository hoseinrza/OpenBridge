import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards, Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { MessagesService } from './messages.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { AddParticipantDto } from './dto/add-participant.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';

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
    return list.map((c, i) => ({ user: users[i], unread: c.unread, updatedAt: c.updatedAt }));
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
