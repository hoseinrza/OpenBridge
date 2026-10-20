import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadScanner } from './upload-scanner';

@Module({
  controllers: [UploadsController],
  providers:   [UploadScanner],
})
export class UploadsModule {}
