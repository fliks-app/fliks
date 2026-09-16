import { IsBoolean, IsOptional } from 'class-validator';

export class SetChannelPrefsDto {
  @IsOptional()
  @IsBoolean()
  favorite?: boolean;

  @IsOptional()
  @IsBoolean()
  hidden?: boolean;
}
