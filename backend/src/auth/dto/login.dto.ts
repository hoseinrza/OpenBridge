import { Transform } from 'class-transformer';
import { IsByteLength, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  username: string;

  @IsString()
  @MinLength(1)
  @IsByteLength(1, 72)
  password: string;
}
