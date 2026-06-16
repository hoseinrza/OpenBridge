import { Body, Controller, Get, NotFoundException, Param, Patch, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  async findAll() {
    const users = await this.users.findAll();
    return this.users.withOnlineStatus(users);
  }

  @Get('me')
  me(@Request() req) { return req.user; }

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

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundException('کاربر پیدا نشد');
    const [withStatus] = await this.users.withOnlineStatus([user]);
    return withStatus;
  }
}
