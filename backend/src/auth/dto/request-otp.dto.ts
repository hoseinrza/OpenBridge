import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { normalizeIranMobile } from '../../common/phone';

export class RequestOtpDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeIranMobile(value) : value))
  @IsString()
  @Matches(/^09\d{9}$/, { message: 'شماره موبایل معتبر نیست' })
  phone: string;
}
