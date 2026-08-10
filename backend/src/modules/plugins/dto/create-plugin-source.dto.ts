import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreatePluginSourceDto {
  @IsString()
  @IsNotEmpty()
  url: string;

  /** Base64, raw 32-byte Ed25519 — same format `keys/*.pub` uses. Omit to defer to `OFFICIAL_KEYS`. */
  @IsOptional()
  @IsString()
  publicKey?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
