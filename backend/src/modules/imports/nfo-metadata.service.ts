import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cheerio from 'cheerio';

export interface NfoData {
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  title?: string;
  originalTitle?: string;
  year?: number;
  plot?: string;
  genres?: string[];
  runtime?: number;
  rating?: number;
  /** ISO `YYYY-MM-DD`. */
  premiered?: string;
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
  async readForVideoFile(videoAbsPath: string): Promise<NfoData | null> {
    const dir = path.dirname(videoAbsPath);
    const base = path.basename(videoAbsPath, path.extname(videoAbsPath));
    const candidates = [
      path.join(dir, `${base}.nfo`),
      path.join(dir, 'movie.nfo'),
      path.join(dir, 'tvshow.nfo'),
      path.join(path.dirname(dir), 'tvshow.nfo'),
    ];

    const merged: NfoData = {};
    let found = false;
    for (const candidate of candidates) {
      const ids = await this.readNfoFile(candidate);
      if (!ids) continue;
      found = true;
      // The most specific sidecar is read first; only fill keys still empty so
      // it keeps the title/episode hint while show-level files backfill ids.
      for (const [key, value] of Object.entries(ids) as [
        keyof NfoData,
        NfoData[keyof NfoData],
      ][]) {
        if (merged[key] == null && value != null) {
          (merged[key] as NfoData[keyof NfoData]) = value;
        }
      }
      if (merged.tmdbId || merged.tvdbId || merged.imdbId) break;
    }
    return found ? merged : null;
  }

  async readNfoFile(nfoAbsPath: string): Promise<NfoData | null> {
    let xml: string;
    try {
      xml = await fs.readFile(nfoAbsPath, 'utf8');
    } catch {
      return null;
    }
    return this.parse(xml);
  }

  /** Pure XML → data extraction. */
  parse(xml: string): NfoData {
    const out: NfoData = {};
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

      // Single-tag id fields — an alternate NFO convention to <uniqueid>.
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

      const originalTitle = $('originaltitle').first().text().trim();
      if (originalTitle) out.originalTitle = originalTitle;

      const plot =
        $('plot').first().text().trim() || $('outline').first().text().trim();
      if (plot) out.plot = plot;

      const genres = new Set<string>();
      $('genre').each((_, el) => {
        const g = $(el).text().trim();
        if (g) genres.add(g);
      });
      if (genres.size) out.genres = [...genres];

      const runtime = toInt($('runtime').first().text());
      if (runtime) out.runtime = runtime;

      const rating = toRating(
        $('ratings rating[default="true"] value').first().text() ||
          $('ratings rating value').first().text() ||
          $('rating').first().text(),
      );
      if (rating != null) out.rating = rating;

      const premieredRaw = (
        $('premiered').first().text() || $('aired').first().text()
      ).trim();
      const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(premieredRaw)?.[1];
      if (isoDate && !Number.isNaN(Date.parse(isoDate))) out.premiered = isoDate;

      const year = toInt($('year').first().text());
      if (year) out.year = year;
      else {
        const y = toInt(premieredRaw.slice(0, 4));
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

function toRating(value: string): number | undefined {
  const n = parseFloat((value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
}
