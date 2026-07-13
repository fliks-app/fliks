import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/** Recommend a movie (mediaId only), a season (+seasonId) or an episode
 *  (+episodeId) to another member, with an optional note. */
export class RecommendContentDto {
  @IsInt()
  recipientId: number;

  @IsInt()
  mediaId: number;

  @IsInt()
  @IsOptional()
  seasonId?: number;

  @IsInt()
  @IsOptional()
  episodeId?: number;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  message?: string;
}
