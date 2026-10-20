import {
  Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query,
  Request, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { CONTACT_MATCH_LIMIT, CONTACT_MATCH_WINDOW_SECONDS } from '../config/env';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { MatchContactsDto } from './dto/match-contacts.dto';

@Controller('users')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  async findAll() {
    const users = await this.users.findAll();
    return this.users.withOnlineStatus(users);
  }

  @Get('me')
  me(@Request() req) {
    const { sessionId, ...user } = req.user;
    return user;
  }

  @Patch('me')
  updateMe(@Request() req, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(req.user.id, dto);
  }

  @Get('search')
  async search(@Request() req, @Query('q') q?: string) {
    const query = q?.trim();
    if (!query) return [];
    const users = await this.users.search(query, req.user.id);
    return this.users.withOnlineStatus(users);
  }

  // Address-book sync. The client sends the numbers it already holds; the
  // reply only says which of them belong to an account.
  @Post('contacts/match')
  @HttpCode(200)
  @RateLimit({ limit: CONTACT_MATCH_LIMIT, windowMs: CONTACT_MATCH_WINDOW_SECONDS * 1000 })
  matchContacts(@Request() req, @Body() dto: MatchContactsDto) {
    return this.users.matchContacts(req.user.id, dto.phones);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundException('کاربر پیدا نشد');
    const [withStatus] = await this.users.withOnlineStatus([user]);
    return withStatus;
  }
}
