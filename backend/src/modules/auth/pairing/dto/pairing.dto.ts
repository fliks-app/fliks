import { IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class PairingRequestDto {
  @IsInt()
  userId: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  deviceName: string;
}
