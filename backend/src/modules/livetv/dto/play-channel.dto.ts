import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class PlayChannelDto {
  /** The client's engine can eat the upstream container/codecs as-is. */
  @IsOptional()
  @IsBoolean()
  directPlay?: boolean;

  /** Presence alone selects transcode mode over remux. */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxBitrateBps?: number;

  @IsOptional()
  @IsBoolean()
  useTs?: boolean;
}
