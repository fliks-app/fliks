import { IsInt, IsOptional } from 'class-validator';

/** Identifies the liked content: a movie (mediaId only), a season (+seasonId)
 *  or an episode (+episodeId). */
export class LikeTargetDto {
  @IsInt()
  mediaId: number;

  @IsInt()
  @IsOptional()
  seasonId?: number;

  @IsInt()
  @IsOptional()
  episodeId?: number;
}
