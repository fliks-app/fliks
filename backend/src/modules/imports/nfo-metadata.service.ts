import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cheerio from 'cheerio';

export interface NfoIds {
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  title?: string;
  year?: number;
}

/**
 * Reads Kodi-style `.nfo` sidecar files to recover provider ids and a
 * title/year hint for a video file. Pure best-effort: a missing file
 * returns null and malformed XML returns an empty object — never throws.
 */
@Injectable()
export class NfoMetadataService {
  private readonly log = new Logger(NfoMetadataService.name);

  /**
   * Locate and read the most relevant `.nfo` next to a video file. Tries the
   * per-file sidecar first (`<name>.nfo`), then a generic `movie.nfo` in the
   * same folder, then `tvshow.nfo` in the same folder and one level up (the
   * usual series layout: `Show/tvshow.nfo` + `Show/Season 01/<ep>.nfo`).
   */
  async readForVideoFile(videoAbsPath: string): Promise<NfoIds | null> {
    const dir = path.dirname(videoAbsPath);
    const base = path.basename(videoAbsPath, path.extname(videoAbsPath));
    const candidates = [
      path.join(dir, `${base}.nfo`),
      path.join(dir, 'movie.nfo'),
      path.join(dir, 'tvshow.nfo'),
      path.join(path.dirname(dir), 'tvshow.nfo'),
    ];

    const merged: NfoIds = {};
    let found = false;
    for (const candidate of candidates) {
      const ids = await this.readNfoFile(candidate);
      if (!ids) continue;
      found = true;
      // The most specific sidecar is read first; only fill keys still empty so
      // it keeps the title/episode hint while show-level files backfill ids.
      for (const [key, value] of Object.entries(ids) as [
        keyof NfoIds,
        NfoIds[keyof NfoIds],
      ][]) {
        if (merged[key] == null && value != null) {
          (merged[key] as NfoIds[keyof NfoIds]) = value;
        }
      }
      if (merged.tmdbId || merged.tvdbId || merged.imdbId) break;
    }
    return found ? merged : null;
  }

  async readNfoFile(nfoAbsPath: string): Promise<NfoIds | null> {
    let xml: string;
    try {
      xml = await fs.readFile(nfoAbsPath, 'utf8');
    } catch {
      return null;
    }
    return this.parse(xml);
  }

  /** Pure XML → ids extraction. */
  parse(xml: string): NfoIds {
    const out: NfoIds = {};
    try {
      const $ = cheerio.load(xml, { xml: true });

      $('uniqueid').each((_, el) => {
        const type = ($(el).attr('type') ?? '').toLowerCase();
        const value = $(el).text().trim();
        if (!value) return;
        if (type === 'tmdb' && !out.tmdbId) out.tmdbId = toInt(value);
        else if (type === 'tvdb' && !out.tvdbId) out.tvdbId = toInt(value);
        else if (type === 'imdb' && !out.imdbId) out.imdbId = value;
      });

      // Legacy single-tag forms.
      if (!out.tmdbId) out.tmdbId = toInt($('tmdbid').first().text());
      if (!out.tvdbId) out.tvdbId = toInt($('tvdbid').first().text());
      if (!out.imdbId) {
        const imdb = $('imdbid').first().text().trim();
        if (imdb) out.imdbId = imdb;
      }
      // <id> is numeric (≈ tvdb) on tvshow, or an `tt…` imdb id.
      const rawId = $('id').first().text().trim();
      if (rawId.startsWith('tt') && !out.imdbId) out.imdbId = rawId;
      else if (rawId && !out.tvdbId && /^\d+$/.test(rawId)) {
        out.tvdbId = toInt(rawId);
      }

      const title =
        $('showtitle').first().text().trim() ||
        $('title').first().text().trim();
      if (title) out.title = title;

      const year = toInt($('year').first().text());
      if (year) out.year = year;
      else {
        const premiered = (
          $('premiered').first().text() || $('aired').first().text()
        ).trim();
        const y = toInt(premiered.slice(0, 4));
        if (y) out.year = y;
      }
    } catch (err) {
      this.log.debug(
        `nfo parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Drop NaN ids that toInt may have produced.
    if (out.tmdbId != null && !Number.isFinite(out.tmdbId)) delete out.tmdbId;
    if (out.tvdbId != null && !Number.isFinite(out.tvdbId)) delete out.tvdbId;
    return out;
  }
}

function toInt(value: string): number | undefined {
  const n = parseInt((value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}
