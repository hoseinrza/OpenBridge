import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';
import { CONTACT_MATCH_MAX_PHONES } from '../../config/env';

export class MatchContactsDto {
  // Raw numbers exactly as the device stores them. Entries that are not Iranian
  // mobile numbers are ignored by the service instead of failing the request,
  // because a real address book is full of landlines and junk.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CONTACT_MATCH_MAX_PHONES)
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  phones: string[];
}
