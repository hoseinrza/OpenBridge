import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { CallsGateway } from './calls.gateway';
import { CallsService } from './calls.service';
import { CallEvents } from './call-events';
import { LiveKitService } from './livekit.service';

@Module({
  controllers: [CallsController],
  providers:   [CallsService, CallsGateway, CallEvents, LiveKitService],
  exports:     [CallsService],
})
export class CallsModule {}
