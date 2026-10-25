import { Module } from '@nestjs/common';
import { ContentCrypto } from './content-crypto.service';

@Module({
  providers: [ContentCrypto],
  exports:   [ContentCrypto],
})
export class ContentCryptoModule {}
