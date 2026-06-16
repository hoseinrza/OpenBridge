import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { MessagesModule } from '../messages/messages.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports:   [MessagesModule, AuthModule],
  providers: [ChatGateway],
})
export class ChatModule {}
