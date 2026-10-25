import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { LEGACY_IMPORT_BATCH } from '../../config/env';

// One decrypted envelope, handed back by a device that still holds the keys.
// Only the shape is checked here; whether the sequence exists, who wrote it and
// whether the attachment belongs to this chat are questions the service answers
// against the database before anything is stored.
class LegacyImportItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  seq: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  // The sender's own descriptor. Its key, nonce and blob id are validated in
  // the service, where the blob's conversation is also known.
  @IsOptional()
  @IsObject()
  attachment?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  replyToSeq?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  forwardedFrom?: string;
}

export class ImportLegacyDto {
  @IsArray()
  @ArrayMaxSize(LEGACY_IMPORT_BATCH)
  @ValidateNested({ each: true })
  @Type(() => LegacyImportItemDto)
  items: LegacyImportItemDto[];
}
