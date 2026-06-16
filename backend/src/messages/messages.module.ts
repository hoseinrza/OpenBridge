import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';

@Module({
  imports:     [UsersModule],
  providers:   [MessagesService],
  controllers: [MessagesController],
  exports:     [MessagesService],
})
export class MessagesModule {}
