import {
  ArrayNotEmpty,
  Equals,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** The only event Rust emits in S1 (F13: delivered to the target user's connections only). */
export class EmitDto {
  @Equals('pairing.requested')
  event!: 'pairing.requested';

  @IsInt()
  userId!: number;

  @IsString()
  pairingId!: string;

  @IsString()
  deviceName!: string;

  @IsString()
  deviceId!: string;
}

export class DropConnectionsDto {
  @IsInt()
  @Min(1)
  userId!: number;

  /** Logout scope: drop only this device; absent = account-wide drop. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  targetId?: string;
}

export class SettingsChangedDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  keys!: string[];

  @IsOptional()
  @IsString()
  origin?: string;
}
