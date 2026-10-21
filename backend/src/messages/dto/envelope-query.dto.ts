import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { E2EE_ENVELOPE_PAGE } from '../../config/env';

// Catch-up window for an encrypted conversation: everything strictly above the
// sequence number the client last processed, oldest first, because MLS refuses
// a ratchet generation it has not seen yet.
export class EnvelopeQueryDto {
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
