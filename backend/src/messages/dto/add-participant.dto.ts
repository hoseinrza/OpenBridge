import { IsUUID } from 'class-validator';

export class AddParticipantDto {
  @IsUUID('4')
  userId: string;
}
