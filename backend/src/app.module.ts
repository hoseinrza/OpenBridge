import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaModule }   from './prisma/prisma.module';
import { RedisModule }    from './redis/redis.module';
import { AuthModule }     from './auth/auth.module';
import { UsersModule }    from './users/users.module';
import { MessagesModule } from './messages/messages.module';
import { ChatModule }     from './chat/chat.module';
import { UploadsModule }  from './uploads/uploads.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    MessagesModule,
    ChatModule,
    UploadsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
