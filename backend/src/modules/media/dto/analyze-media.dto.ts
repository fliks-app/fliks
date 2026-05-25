import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Body for the user-triggered "Analyse" action on a media — granular
 * post-import analyses that can be re-run on demand. The full rescan
 * (which is itself a superset of these) stays on the dedicated
 * `/rescan` endpoint so its SSE event wiring is preserved.
 */
export class AnalyzeMediaDto {
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  sprites?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  crop?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  subtitleCache?: boolean;
}
