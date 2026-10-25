import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { E2EE_ENVELOPE_PAGE } from '../../config/env';

// Which pending sequences to list: the same cursor a catch-up uses, because the
// caller walks the stream in the order it was written.
export class LegacyStatusQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(E2EE_ENVELOPE_PAGE)
  take?: number;
}
