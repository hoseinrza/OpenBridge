import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const SHARED_KINDS = ['media', 'files', 'links'] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

export const SHARED_PAGE = 60;

export class SharedQueryDto {
  @IsIn([...SHARED_KINDS], { message: 'نوع فهرست باید media، files یا links باشد' })
  kind: SharedKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  // Where the previous page stopped. It is an ISO timestamp the server handed
  // out, never a value a client makes up.
  @IsOptional()
  @IsDateString()
  before?: string;
}
