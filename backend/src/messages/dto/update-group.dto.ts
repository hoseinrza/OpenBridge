import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Same bounds createGroup enforces, so a rename can never produce a group the
// create path would have refused.
const NAME_MIN = 2;
const NAME_MAX = 60;
// Telegram's group bio length.
const DESCRIPTION_MAX = 205;

export class UpdateGroupDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(NAME_MIN, { message: `نام گروه باید حداقل ${NAME_MIN} کاراکتر باشد` })
  @MaxLength(NAME_MAX, { message: `نام گروه نباید بیشتر از ${NAME_MAX} کاراکتر باشد` })
  name?: string;

  // An empty string clears the bio, so it is length-checked but not min-length.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(DESCRIPTION_MAX, { message: `توضیح گروه نباید بیشتر از ${DESCRIPTION_MAX} کاراکتر باشد` })
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^\/uploads\/[A-Za-z0-9._-]+$/, { message: 'آدرس تصویر نامعتبر است' })
  avatar?: string;
}
