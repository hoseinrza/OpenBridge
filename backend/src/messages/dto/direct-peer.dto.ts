import { IsUUID } from 'class-validator';

// The peer half of a direct-conversation request. The conversation itself is
// found (or created) from the two accounts, never from a client-supplied id.
export class DirectPeerDto {
  @IsUUID('4')
  userId: string;
}
