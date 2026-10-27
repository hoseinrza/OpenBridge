import { normalizeIranMobile } from './phone';

export const SMS_PROVIDER = 'SMS_PROVIDER';

export interface SmsProvider {
  /** The gateway's display name, used only in logs. */
  readonly name: string;
  sendOtp(phone: string, code: string): Promise<void>;
}

/**
 * Kavenegar wants the local 0xxxxxxxxx spelling; OpenBridge stores every phone
 * already normalized to 09\d{9}, so one shared helper serves both.
 */
export function toKavenegarReceptor(phone: string): string {
  return normalizeIranMobile(phone) ?? phone;
}

/** 0912****0001 — enough to correlate a log line, never a full number. */
export function maskPhone(phone: string): string {
  return phone.length <= 8 ? '****' : `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}
