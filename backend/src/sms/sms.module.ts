import { Module } from '@nestjs/common';
import { SMS_PROVIDER, SmsProvider } from '../common/sms-provider.interface';
import { KavenegarSmsProvider } from '../common/kavenegar-sms.provider';
import { SMS_PROVIDER as CONFIGURED_PROVIDER } from '../config/env';

/**
 * One provider per deployment, selected once at boot: `none` binds nothing and
 * leaves OTP in its pre-provider behaviour, `kavenegar` binds the gateway.
 * AuthService injects the token optionally, so `none` costs no stub class.
 */
const provider =
  CONFIGURED_PROVIDER === 'kavenegar'
    ? { provide: SMS_PROVIDER, useClass: KavenegarSmsProvider }
    : { provide: SMS_PROVIDER, useValue: null as SmsProvider | null };

@Module({
  providers:   [provider],
  exports:     [SMS_PROVIDER],
})
export class SmsModule {}
