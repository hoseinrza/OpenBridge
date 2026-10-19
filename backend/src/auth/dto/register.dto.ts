import { Transform } from 'class-transformer';
import { IsByteLength, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد و _ باشد' })
  username: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName: string;

  @IsString()
  @MinLength(8)
  @IsByteLength(8, 72)
  password: string;
}
