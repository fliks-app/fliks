import { IsArray, IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class BulkUpdateMediaDto {
  @IsArray() @IsNumber({}, { each: true })
  ids: number[];

  @IsOptional() @IsNumber()
  qualityProfileId?: number;

  @IsNumber() @IsOptional()
  languageProfileId?: number;

  @IsOptional() @IsBoolean()
  monitored?: boolean;

  @IsOptional() @IsString()
  rootFolder?: string;
}
