import { Injectable } from '@nestjs/common';
import { CONTENT_KEY } from '../config/env';
import { ContentCipher, createContentCipher, loadContentKey } from './content-crypto';

/**
 * The one place the application reaches the content cipher. The master key is
 * validated when the process starts, so a missing or malformed CONTENT_KEY
 * stops the server instead of leaving message text in plaintext.
 */
@Injectable()
export class ContentCrypto implements ContentCipher {
  private readonly cipher = createContentCipher(loadContentKey(CONTENT_KEY));

  sealText(conversationId: string, text: string): string {
    return this.cipher.sealText(conversationId, text);
  }

  openText(conversationId: string, payload: string | null | undefined): string | null {
    return this.cipher.openText(conversationId, payload);
  }

  sealFile(filename: string, bytes: Buffer): Buffer {
    return this.cipher.sealFile(filename, bytes);
  }

  openFile(filename: string, bytes: Buffer): Buffer {
    return this.cipher.openFile(filename, bytes);
  }
}
