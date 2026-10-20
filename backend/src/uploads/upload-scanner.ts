import { Injectable } from '@nestjs/common';
import { createConnection, Socket } from 'net';
import { open } from 'fs/promises';

export interface ScanResult {
  clean: boolean;
  signature?: string;
}

interface ScannerConfig {
  enabled: boolean;
  host: string;
  port: number;
  timeoutMs: number;
}

function readConfig(): ScannerConfig {
  const rawEnabled = (process.env.UPLOAD_SCAN_ENABLED ?? 'false').trim().toLowerCase();
  if (!['true', 'false', '1', '0'].includes(rawEnabled)) {
    throw new Error('UPLOAD_SCAN_ENABLED must be true or false');
  }
  if (rawEnabled === 'false' || rawEnabled === '0') {
    return { enabled: false, host: '', port: 0, timeoutMs: 0 };
  }

  const host = (process.env.CLAMAV_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  const timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS ?? 15000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('CLAMAV_PORT must be a valid TCP port');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('CLAMAV_TIMEOUT_MS must be a positive integer');
  }
  return { enabled: true, host, port, timeoutMs };
}

function write(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, error => (error ? reject(error) : resolve()));
  });
}

/**
 * Streams a file to a clamd instance using the INSTREAM protocol. Disabled by
 * default; when enabled, any scan failure rejects so the upload fails closed.
 */
@Injectable()
export class UploadScanner {
  private readonly config = readConfig();

  get enabled() {
    return this.config.enabled;
  }

  async scan(path: string): Promise<ScanResult> {
    if (!this.config.enabled) return { clean: true };

    return new Promise<ScanResult>((resolve, reject) => {
      const socket = createConnection({ host: this.config.host, port: this.config.port });
      const responseChunks: Buffer[] = [];
      let settled = false;

      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        action();
      };

      socket.setTimeout(this.config.timeoutMs, () => {
        settle(() => reject(new Error('clamd scan timed out')));
      });
      socket.on('error', error => {
        settle(() => reject(error));
      });
      socket.on('data', chunk => responseChunks.push(chunk));
      socket.on('end', () => {
        const response = Buffer.concat(responseChunks).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
        if (response === 'stream: OK') {
          settle(() => resolve({ clean: true }));
          return;
        }
        const found = response.match(/^stream: (.+) FOUND$/);
        if (found) {
          settle(() => resolve({ clean: false, signature: found[1] }));
          return;
        }
        settle(() => reject(new Error(`unexpected clamd response: ${response.slice(0, 120)}`)));
      });

      socket.on('connect', async () => {
        try {
          await write(socket, Buffer.from('zINSTREAM\0', 'binary'));
          const handle = await open(path, 'r');
          try {
            const chunk = Buffer.alloc(64 * 1024);
            for (;;) {
              const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
              if (bytesRead === 0) break;
              const length = Buffer.alloc(4);
              length.writeUInt32BE(bytesRead, 0);
              await write(socket, length);
              await write(socket, chunk.subarray(0, bytesRead));
            }
          } finally {
            await handle.close().catch(() => {});
          }
          await write(socket, Buffer.alloc(4));
        } catch (error) {
          settle(() => reject(error));
        }
      });
    });
  }
}
