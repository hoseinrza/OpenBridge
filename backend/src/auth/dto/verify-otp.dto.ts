import { Transform } from 'class-transformer';
import {
  IsOptional, IsString, Matches, MaxLength, MinLength,
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

  // Required only when the phone number does not have an account yet.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد و _ باشد' })
  username?: string;
}
