import { IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateMarkerDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  startSeconds?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  endSeconds?: number;
}
