import { IsString, Length, MaxLength } from 'class-validator';

/** A device offering itself for control by whoever can read its screen. */
export class CreateGrantCodeDto {
  @IsString()
  @MaxLength(128)
  deviceId: string;

  @IsString()
  @MaxLength(80)
  deviceName: string;
}

export class ClaimGrantDto {
  @IsString()
  @Length(4, 12)
  code: string;
}
