import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateCleanupProfileDto {
  @IsOptional()
  @IsInt()
  @Min(2)
  samples?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMinutes?: number;

  @IsOptional()
  @IsBoolean()
  autoRestart?: boolean;
}
