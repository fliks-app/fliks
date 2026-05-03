import { IsEnum, IsInt, IsNumber, Min } from 'class-validator';

export class CreateMarkerDto {
  @IsInt()
  episodeId: number;

  @IsEnum(['intro', 'outro', 'recap'])
  type: 'intro' | 'outro' | 'recap';

  @IsNumber()
  @Min(0)
  startSeconds: number;

  @IsNumber()
  @Min(0)
  endSeconds: number;
}
