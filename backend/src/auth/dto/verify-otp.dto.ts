import { Transform } from 'class-transformer';
import {
  IsOptional, IsString, Matches, MaxLength,
} from 'class-validator';
import { normalizeIranMobile } from '../../common/phone';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class VerifyOtpDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeIranMobile(value) : value))
  @IsString()
  @Matches(/^09\d{9}$/, { message: 'شماره موبایل معتبر نیست' })
  phone: string;

  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'کد تأیید باید ۶ رقم باشد' })
  code: string;
}
