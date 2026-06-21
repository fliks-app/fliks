import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class PairingRequestDto {
  @IsInt()
  userId: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  deviceName: string;

  /** Real host OS name+version ("macOS 26") resolved natively by the requester. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  systemName?: string;
}
