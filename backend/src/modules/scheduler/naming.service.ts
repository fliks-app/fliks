import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.flv']);

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
    name = name.replace(/\{Original Title\}/g, data.originalTitle || data.title || '');
    name = name.replace(/\{Release Year\}/g, data.year ? String(data.year) : '');
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
    name = name.replace(/\{episode:00\}/g, String(data.episode).padStart(2, '0'));
    name = name.replace(/\{Episode Title\}/g, data.episodeTitle ?? '');
    name = name.replace(/\{Quality Full\}/g, data.quality ?? '');
    name = name.replace(/\{Quality Title\}/g, data.quality ?? '');
    name = name.replace(/\{Release Group\}/g, data.releaseGroup ?? '');
    name = name.replace(/\{Air Date\}/g, data.airDate ?? '');
    name = name.replace(/\{MediaInfo AudioCodec\}/g, '');
    name = name.replace(/\{MediaInfo VideoCodec\}/g, '');
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
    name = name.replace(/\{Release Year\}/g, data.year ? String(data.year) : '');
    name = name.replace(/\{TMDB Id\}/g, data.tmdbId ? String(data.tmdbId) : '');
    return this.sanitize(name);
  }

  applySeasonFolderFormat(
    format: string,
    data: { season: number },
  ): string {
    let name = format;
    name = name.replace(/\{season:00\}/g, String(data.season).padStart(2, '0'));
    name = name.replace(/\{season\}/g, String(data.season));
    return this.sanitize(name);
  }

  parseQuality(sourceTitle: string): string {
    const upper = sourceTitle.toUpperCase();
    if (upper.includes('2160P') || upper.includes('4K') || upper.includes('UHD'))
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

  parseEpisodeNumbers(sourceTitle: string): { season: number; episode: number } | null {
    const m = sourceTitle.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (!m) return null;
    return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  }

  findLargestVideoFile(dirPath: string): { filePath: string; size: number } | null {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      let best: { filePath: string; size: number } | null = null;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sub = this.findLargestVideoFile(path.join(dirPath, entry.name));
          if (sub && (!best || sub.size > best.size)) best = sub;
        } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);
          if (!best || stat.size > best.size) {
            best = { filePath: fullPath, size: stat.size };
          }
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  private sanitize(name: string): string {
    return name
      .replace(/\{[^}]*\}/g, '')        // remove unreplaced tokens
      .replace(/undefined/g, '')         // remove stray "undefined"
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\(\s*\)/g, '')           // remove empty parentheses
      .replace(/\[\s*\]/g, '')           // remove empty brackets
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}
