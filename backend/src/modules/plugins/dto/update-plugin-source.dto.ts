import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdatePluginSourceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  url?: string;

  /** `null` clears a pinned key back to `OFFICIAL_KEYS`; omit to leave it unchanged. */
  @IsOptional()
  @IsString()
  publicKey?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
