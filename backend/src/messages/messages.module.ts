import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ContentCryptoModule } from '../common/content-crypto.module';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { GroupEvents } from './group-events';

@Module({
  imports:     [UsersModule, ContentCryptoModule],
  providers:   [MessagesService, GroupEvents],
  controllers: [MessagesController],
  exports:     [MessagesService, GroupEvents],
})
export class MessagesModule {}
