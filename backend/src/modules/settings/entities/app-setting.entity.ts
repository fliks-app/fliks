import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * Generic key-value store for application settings.
 * Keys are stable identifiers; values are stored as text (JSON-encoded if needed).
 *
 * Known keys:
 *   naming_movie_format   — e.g. "{Movie.Title} ({Movie.Year}) [{Quality.Name}]"
 *   naming_series_format        — e.g. "{Series Title} - S{season:00}E{episode:00} - {Episode Title}"
 *   (default_root_folder_movie/series removed — migrated to Library.isDefaultForMovies/Series)
 *   naming_movie_folder_format  — e.g. "{Movie Title} ({Release Year})"
 *   naming_series_folder_format — e.g. "{Series Title}"
 *   naming_season_folder_format — e.g. "Season {season:00}"
 *   companion_file_extensions — comma-separated list, e.g. ".nfo,.srt,.jpg"
 *   search_missing_auto   — "true" | "false"
 *   rss_sync_interval     — minutes, e.g. "15"
 */
@Entity('app_settings')
export class AppSetting extends BaseEntity {
  @Column({ unique: true })
  key: string;

  @Column({ type: 'text', nullable: true })
  value: string | null;
}
