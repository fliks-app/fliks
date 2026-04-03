import { IsNumber, IsOptional, IsArray, Min } from 'class-validator';

export class CreateDelayProfileDto {
  @IsNumber()
  @Min(0)
  torrentDelay: number;

  @IsNumber()
  @IsOptional()
  order?: number;

  @IsArray()
  @IsNumber({}, { each: true })
  @IsOptional()
  tagIds?: number[];
}
