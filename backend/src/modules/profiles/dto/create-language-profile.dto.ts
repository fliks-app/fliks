import { IsString, IsNumber, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class LanguageItemDto {
  @IsNumber()
  languageId: number;

  @IsString()
  languageName: string;

  @IsString()
  isoCode: string;

  @IsBoolean()
  allowed: boolean;

  @IsNumber()
  sortOrder: number;
}

export class CreateLanguageProfileDto {
  @IsString()
  name: string;

  @IsNumber()
  cutoff: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LanguageItemDto)
  languages: LanguageItemDto[];
}
