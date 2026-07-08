import { IsInt, IsOptional } from 'class-validator';

/**
 * Exactly one axis is used, which selects the scope:
 *   - `episodeId` → add that single episode
 *   - `seasonId`  → add every episode of that season
 *   - `mediaId`   → add the movie, or (for a series) all its episodes
 */
export class AddPlaylistItemDto {
  @IsOptional()
  @IsInt()
  mediaId?: number;

  @IsOptional()
  @IsInt()
  episodeId?: number;

  @IsOptional()
  @IsInt()
  seasonId?: number;
}
