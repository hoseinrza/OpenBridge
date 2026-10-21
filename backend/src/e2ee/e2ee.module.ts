import { Module } from '@nestjs/common';
import { E2eeService } from './e2ee.service';
import { E2eeController } from './e2ee.controller';

@Module({
  providers:   [E2eeService],
  controllers: [E2eeController],
  exports:     [E2eeService],
})
export class E2eeModule {}
