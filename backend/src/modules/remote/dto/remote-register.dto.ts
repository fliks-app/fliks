import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Announce from a client that cannot hold an SSE stream. The target id is
 *  derived from `deviceId` server-side, never accepted from the caller. */
export class RemoteRegisterDto {
  @IsString()
  @MaxLength(128)
  deviceId: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  formFactor?: string;
}
