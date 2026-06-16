import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
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
    return list.map((c, i) => ({ user: users[i], unread: c.unread }));
  }

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
