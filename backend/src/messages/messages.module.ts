import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { GroupEvents } from './group-events';

@Module({
  imports:     [UsersModule],
  providers:   [MessagesService, GroupEvents],
  controllers: [MessagesController],
  exports:     [MessagesService, GroupEvents],
})
export class MessagesModule {}
