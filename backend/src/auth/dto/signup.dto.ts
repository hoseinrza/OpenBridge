import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Letters only (any script, including Persian ZWNJ), with spaces, apostrophes
// and hyphens allowed inside the name. 2 characters minimum, 50 maximum.
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}\u200c'’ .-]{1,49}$/u;

export class SignupDto {
  @Transform(trim)
  @IsString()
  @MaxLength(1024)
  signupToken: string;

  @Transform(trim)
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{2,30}$/, { message: 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد و _ باشد (۲ تا ۳۰ کاراکتر)' })
  username: string;

  @Transform(trim)
  @IsString()
  @Matches(NAME_PATTERN, { message: 'نام باید حداقل ۲ حرف باشد و عدد نداشته باشد' })
  firstName: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(NAME_PATTERN, { message: 'نام خانوادگی باید حداقل ۲ حرف باشد و عدد نداشته باشد' })
  lastName?: string;
}
