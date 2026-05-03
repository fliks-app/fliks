import { IsNumber, IsOptional, Min } from 'class-validator';

export class CreateDelayProfileDto {
  @IsNumber()
  @Min(0)
  torrentDelay: number;

  @IsNumber()
  @IsOptional()
  order?: number;
}
