import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CallTokenDto {
  // Mobile cannot yet derive the MLS media key, so the server refuses an E2EE
  // room token for it instead of letting it join without encryption.
  @IsIn(['web', 'mobile'])
  client: 'web' | 'mobile';

  // A hash of the media key, never the key. Required when the call is E2EE.
  @IsOptional()
  @IsString()
  @Length(16, 128)
  keyFingerprint?: string;
}
