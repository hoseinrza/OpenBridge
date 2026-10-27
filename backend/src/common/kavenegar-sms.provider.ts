import { Injectable, Logger } from '@nestjs/common';
import { KAVENEGAR_API_KEY, KAVENEGAR_OTP_TEMPLATE, KAVENEGAR_SENDER } from '../config/env';
import { SmsProvider, maskPhone, toKavenegarReceptor } from './sms-provider.interface';

const KAVENEGAR_BASE_URL = 'https://api.kavenegar.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

interface KavenegarResponse {
  return?: { status?: number; message?: string };
}

/**
 * Kavenegar (https://kavenegar.com) over Node's built-in fetch — no vendor SDK.
 *
 * Two modes, copied from the shape the gateway actually needs:
 * - `KAVENEGAR_OTP_TEMPLATE` set: `verify/lookup.json`, Kavenegar's dedicated
 *   OTP path. It needs no sender line and is not subject to the telecom content
 *   filtering that routinely blocks free-text messages carrying codes.
 * - No template: plain `sms/send.json`, which only delivers reliably from a
 *   dedicated `KAVENEGAR_SENDER`.
 */
@Injectable()
export class KavenegarSmsProvider implements SmsProvider {
  readonly name = 'kavenegar';
  private readonly logger = new Logger(KavenegarSmsProvider.name);

  async sendOtp(phone: string, code: string): Promise<void> {
    const receptor = toKavenegarReceptor(phone);

    if (KAVENEGAR_OTP_TEMPLATE) {
      await this.post('verify/lookup', { receptor, token: code, template: KAVENEGAR_OTP_TEMPLATE });
    } else {
      const params: Record<string, string> = { receptor, message: `کد تأیید شما: ${code}` };
      if (KAVENEGAR_SENDER) params.sender = KAVENEGAR_SENDER;
      await this.post('sms/send', params);
    }

    this.logger.log(`OTP delivered to ${maskPhone(receptor)} via kavenegar`);
  }

  private async post(method: string, params: Record<string, string>): Promise<void> {
    const url = `${KAVENEGAR_BASE_URL}/${KAVENEGAR_API_KEY}/${method}.json`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        // Without this an unreachable gateway hangs the request indefinitely,
        // which hangs POST /auth/otp/request and looks like a dead API.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Only the error name travels: a fetch TypeError can carry the request
      // target, which contains the account key.
      throw new Error(`kavenegar ${method} request failed: ${(error as Error)?.name ?? 'error'}`);
    }

    // Kavenegar signals failure both in the HTTP status and in return.status,
    // so both are checked. The response body is never included in the thrown
    // message because it echoes the receptor, i.e. the phone number.
    const payload = (await response.json().catch(() => undefined)) as KavenegarResponse | undefined;
    const status = payload?.return?.status;
    if (!response.ok || status !== 200) {
      throw new Error(
        `kavenegar ${method} refused: http=${response.status} status=${String(status)}`,
      );
    }
  }
}
