import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class UpdateLiveTvChannelDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  number?: number;

  @IsOptional()
  @IsString()
  groupName?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  guideShiftMinutes?: number;

  /** Manual guide assignment, routed to `setGuideChannel` (sticky `guideMatchKind: 'manual'`). */
  @IsOptional()
  @IsString()
  guideChannelId?: string;
}
