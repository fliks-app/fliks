import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const VIDEO_EXTS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.ts',
  '.m2ts',
  '.wmv',
  '.flv',
]);

@Injectable()
export class NamingService {
  applyMovieFormat(
    format: string,
    data: {
      title: string;
      originalTitle?: string;
      year?: number | null;
      quality: string;
      releaseGroup?: string;
      tmdbId?: number | null;
    },
  ): string {
    let name = format;
    name = name.replace(/\{Movie Title\}/g, data.title ?? '');
    name = name.replace(
      /\{Original Title\}/g,
      data.originalTitle || data.title || '',
    );
    name = name.replace(
      /\{Release Year\}/g,
      data.year ? String(data.year) : '',
    );
    name = name.replace(/\{Quality Full\}/g, data.quality ?? '');
    name = name.replace(/\{Quality Title\}/g, data.quality ?? '');
    name = name.replace(/\{Release Group\}/g, data.releaseGroup ?? '');
    name = name.replace(/\{TMDB Id\}/g, data.tmdbId ? String(data.tmdbId) : '');
    name = name.replace(/\{MediaInfo AudioCodec\}/g, '');
    name = name.replace(/\{MediaInfo VideoCodec\}/g, '');
    return this.sanitize(name);
  }

  applySeriesFormat(
    format: string,
    data: {
      seriesTitle: string;
      season: number;
      episode: number;
      episodeTitle?: string;
      quality: string;
      releaseGroup?: string;
      airDate?: string | null;
    },
  ): string {
    let name = format;
    name = name.replace(/\{Series Title\}/g, data.seriesTitle ?? '');
    name = name.replace(/\{season:00\}/g, String(data.season).padStart(2, '0'));
    name = name.replace(
      /\{episode:00\}/g,
      String(data.episode).padStart(2, '0'),
    );
    name = name.replace(/\{Episode Title\}/g, data.episodeTitle ?? '');
    name = name.replace(/\{Quality Full\}/g, data.quality ?? '');
    name = name.replace(/\{Quality Title\}/g, data.quality ?? '');
    name = name.replace(/\{Release Group\}/g, data.releaseGroup ?? '');
    name = name.replace(/\{Air Date\}/g, data.airDate ?? '');
    name = name.replace(/\{MediaInfo AudioCodec\}/g, '');
    name = name.replace(/\{MediaInfo VideoCodec\}/g, '');
    return this.sanitize(name);
  }

  applyMovieFolderFormat(
    format: string,
    data: {
      title: string;
      originalTitle?: string;
      year?: number | null;
      tmdbId?: number | null;
    },
  ): string {
    let name = format;
    name = name.replace(/\{Movie Title\}/g, data.title ?? '');
    name = name.replace(
      /\{Original Title\}/g,
      data.originalTitle || data.title || '',
    );
    name = name.replace(
      /\{Release Year\}/g,
      data.year ? String(data.year) : '',
    );
    name = name.replace(/\{TMDB Id\}/g, data.tmdbId ? String(data.tmdbId) : '');
    return this.sanitize(name);
  }

  applySeriesFolderFormat(
    format: string,
    data: {
      seriesTitle: string;
      year?: number | null;
      tmdbId?: number | null;
    },
  ): string {
    let name = format;
    name = name.replace(/\{Series Title\}/g, data.seriesTitle ?? '');
    name = name.replace(
      /\{Release Year\}/g,
      data.year ? String(data.year) : '',
    );
    name = name.replace(/\{TMDB Id\}/g, data.tmdbId ? String(data.tmdbId) : '');
    return this.sanitize(name);
  }

  applySeasonFolderFormat(format: string, data: { season: number }): string {
    let name = format;
    name = name.replace(/\{season:00\}/g, String(data.season).padStart(2, '0'));
    name = name.replace(/\{season\}/g, String(data.season));
    return this.sanitize(name);
  }

  parseQuality(sourceTitle: string): string {
    const upper = sourceTitle.toUpperCase();
    if (
      upper.includes('2160P') ||
      upper.includes('4K') ||
      upper.includes('UHD')
    )
      return '2160p';
    if (upper.includes('1080P')) return '1080p';
    if (upper.includes('720P')) return '720p';
    if (upper.includes('480P')) return '480p';
    if (upper.includes('BLURAY') || upper.includes('BLU-RAY')) return 'Bluray';
    if (upper.includes('BDRIP')) return 'BDRip';
    if (upper.includes('BRRIP')) return 'BRRip';
    if (upper.includes('WEBRIP')) return 'WEBRip';
    if (upper.includes('WEB-DL') || upper.includes('WEBDL')) return 'WEB-DL';
    if (upper.includes('WEB')) return 'WEB';
    if (upper.includes('HDTV')) return 'HDTV';
    if (upper.includes('DVDRIP')) return 'DVDRip';
    if (upper.includes('DVDSCR')) return 'DVDSCR';
    if (upper.includes('HDCAM') || upper.includes('HD-CAM')) return 'HDCAM';
    if (upper.includes('CAM') || upper.includes('CAMRIP')) return 'CAM';
    if (upper.includes('HDTS') || upper.includes('TELESYNC')) return 'Telesync';
    if (upper.includes('REMUX')) return 'Remux';
    return '';
  }

  extractReleaseGroup(sourceTitle: string): string {
    const m = sourceTitle.match(/-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$/i);
    return m?.[1] ?? '';
  }

  /**
   * Parse episode numbers from a string (filename or release title).
   * Regex cascade ported from Sonarr's Parser.cs — first match wins.
   * Each entry: [regex, seasonGroup, episodeGroup] (0-based capture group indices).
   * A null episodeGroup means "season-only" match (handled by parseSeasonNumber).
   */
  parseEpisodeNumbers(
    sourceTitle: string,
  ): { season: number; episode: number } | null {
    // Normalize separators: dots/underscores → spaces (but keep S01E01 intact)
    const normalized = sourceTitle
      .replace(/[_]/g, ' ')
      .replace(/\.(?!\d{4})/g, ' ');

    const patterns: { re: RegExp; season: number; episode: number }[] = [
      // ---- Standard S01E01 patterns (Sonarr priority order) ----

      // Multi-episode: S01E01-E02 / S01E01E02 / S01E01-02
      {
        re: /[Ss](\d{1,2})[Ee](\d{1,3})(?:[_\-Ee]+\d{1,3})*/,
        season: 1,
        episode: 2,
      },

      // S01E01 standard (most common)
      { re: /[Ss](\d{1,2})\s*[Ee](\d{1,3})/, season: 1, episode: 2 },

      // S01.E01 / S01 E01 / S01_E01
      { re: /[Ss](\d{1,2})\s*[.\- _][Ee](\d{1,3})/, season: 1, episode: 2 },

      // ---- Cross/x notation ----

      // 1x05 / 01x05
      { re: /(\d{1,2})[xX](\d{2,3})/, season: 1, episode: 2 },

      // ---- Bare season + episode (no letter prefix) ----

      // "Title 103" → season 1, episode 03 (compact 3-digit, only if no year nearby)
      { re: /(?:^|[\s.])(\d)(\d{2})(?:[\s.]|$)/, season: 1, episode: 2 },

      // ---- Part / Episode word patterns ----

      // "Part 3" / "Part.3" / "Pt 3" (season defaults to 1)
      { re: /(?:Part|Pt)\s*\.?\s*(\d{1,3})/i, season: -1, episode: 1 },

      // "Episode 3" / "Ep 3" / "E03" at word boundary (season defaults to 1)
      { re: /(?:Episode|Ep)\s*\.?\s*(\d{1,3})/i, season: -1, episode: 1 },

      // ---- Anime absolute numbering ----

      // " - 03" (dash followed by episode number, common in anime)
      { re: /(?:^|[\s.])- (\d{2,4})(?:[\s.]|$)/, season: -1, episode: 1 },

      // "E03" standalone (no season prefix)
      { re: /[Ee](\d{2,3})(?:[^a-zA-Z\d]|$)/, season: -1, episode: 1 },
    ];

    for (const { re, season: sIdx, episode: eIdx } of patterns) {
      const m = normalized.match(re) ?? sourceTitle.match(re);
      if (!m) continue;
      const episode = parseInt(m[eIdx], 10);
      if (!Number.isFinite(episode) || episode < 1) continue;

      if (sIdx === -1) {
        // No season in regex — default to season 1
        return { season: 1, episode };
      }
      const season = parseInt(m[sIdx], 10);
      if (!Number.isFinite(season) || season < 0) continue;
      return { season, episode };
    }

    return null;
  }

  /**
   * Parse season number only (for season packs like "S02.COMPLETE").
   */
  parseSeasonNumber(sourceTitle: string): number | null {
    const m = sourceTitle.match(/[Ss](\d{1,2})(?![Ee.\d])/);
    return m ? parseInt(m[1], 10) : null;
  }

  findLargestVideoFile(
    dirPath: string,
  ): { filePath: string; size: number } | null {
    const all = this.findAllVideoFiles(dirPath);
    if (!all.length) return null;
    return all.reduce((best, f) => (f.size > best.size ? f : best));
  }

  /**
   * Find all video files recursively in a directory.
   * Sorted by filename for natural episode order.
   */
  findAllVideoFiles(dirPath: string): { filePath: string; size: number }[] {
    const results: { filePath: string; size: number }[] = [];
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.findAllVideoFiles(fullPath));
        } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(fullPath);
          results.push({ filePath: fullPath, size: stat.size });
        }
      }
    } catch {
      // ignore
    }
    results.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return results;
  }

  private sanitize(name: string): string {
    return name
      .replace(/\{[^}]*\}/g, '') // remove unreplaced tokens
      .replace(/undefined/g, '') // remove stray "undefined"
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\(\s*\)/g, '') // remove empty parentheses
      .replace(/\[\s*\]/g, '') // remove empty brackets
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}
