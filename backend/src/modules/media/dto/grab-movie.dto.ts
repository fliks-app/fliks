import { IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class GrabMovieDto {
  @IsOptional()
  @IsString()
  downloadUrl?: string;

  @IsOptional()
  @IsString()
  sourceTitle?: string;

  /** Indexer the release came from. Passed by the frontend when grabbing a
   *  specific release row so the Activity page can show which indexer
   *  served the grab; left undefined for raw-URL paste flows where there
   *  is no indexer context. */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  indexerId?: number;
}
