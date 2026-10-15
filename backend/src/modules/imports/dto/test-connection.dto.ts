import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TestConnectionDto {
  @IsString()
  @IsNotEmpty()
  url: string;

  /** Absent or blank: the stored setting is used. */
  @IsOptional()
  @IsString()
  apiKey?: string;
}
