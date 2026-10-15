import { ArrayNotEmpty, IsArray, IsOptional, IsString } from 'class-validator';

export class SettingsChangedDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  keys!: string[];

  @IsOptional()
  @IsString()
  origin?: string;
}
