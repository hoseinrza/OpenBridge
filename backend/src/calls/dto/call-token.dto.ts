import { IsIn } from 'class-validator';

export class CallTokenDto {
  // Mobile has no LiveKit E2EE support, so the server refuses an encrypted room
  // token for it instead of letting it join without encryption.
  @IsIn(['web', 'mobile'])
  client: 'web' | 'mobile';
}
