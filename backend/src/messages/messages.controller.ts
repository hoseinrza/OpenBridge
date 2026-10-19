import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { MessagesService } from './messages.service';

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
  createGroup(@Request() req, @Body() body: { name: string; memberIds: string[] }) {
    return this.messages.createGroup(req.user.id, body.name, body.memberIds ?? []);
  }

  @Get('groups/:conversationId')
  getGroupMessages(
    @Request()               req,
    @Param('conversationId') conversationId: string,
    @Query('take')           take?: string,
    @Query('skip')           skip?: string,
  ) {
    return this.messages.getConversationMessages(
      conversationId, req.user.id,
      take ? +take : 50,
      skip ? +skip : 0,
    );
  }

  @Post('groups/:conversationId/participants')
  addParticipant(
    @Request()               req,
    @Param('conversationId') conversationId: string,
    @Body()                  body: { userId: string },
  ) {
    return this.messages.addParticipant(conversationId, req.user.id, body.userId);
  }

  @Delete('groups/:conversationId/participants/:userId')
  removeParticipant(
    @Request()               req,
    @Param('conversationId') conversationId: string,
    @Param('userId')         userId: string,
  ) {
    return this.messages.removeParticipant(conversationId, req.user.id, userId);
  }

  // ── Direct (1-to-1) chat ─────────────────────────────
  @Get(':userId')
  getConversation(
    @Request()         req,
    @Param('userId')   userId: string,
    @Query('take')     take?: string,
    @Query('skip')     skip?: string,
  ) {
    return this.messages.getConversation(
      req.user.id, userId,
      take ? +take : 50,
      skip ? +skip : 0,
    );
  }
}
