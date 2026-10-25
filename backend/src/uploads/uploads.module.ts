import { Module } from '@nestjs/common';
import { ContentCryptoModule } from '../common/content-crypto.module';
import { UploadsController } from './uploads.controller';
import { UploadScanner } from './upload-scanner';

@Module({
  imports:     [ContentCryptoModule],
  controllers: [UploadsController],
  providers:   [UploadScanner],
})
export class UploadsModule {}
