import { ArrayMaxSize, ArrayMinSize, IsArray, IsBase64, MaxLength } from 'class-validator';
import { E2EE_MAX_PACKAGES_PER_UPLOAD, E2EE_MAX_PACKAGE_CHARS } from '../../config/env';

export class UploadKeyPackagesDto {
  // Opaque MLS KeyPackage bytes, standard base64. The server stores them as they
  // arrive and never decodes them, so validation is format and size only.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(E2EE_MAX_PACKAGES_PER_UPLOAD)
  @IsBase64({}, { each: true })
  @MaxLength(E2EE_MAX_PACKAGE_CHARS, { each: true })
  packages: string[];
}
