import * as fs from 'fs/promises';
import * as path from 'path';

const EXTS = ['jpg', 'jpeg', 'png', 'webp'];

/** Candidate basenames (without extension), in precedence order. */
function candidateNames(kind: 'poster' | 'fanart' | 'logo', basename?: string): string[] {
  switch (kind) {
    case 'poster':
      return [
        ...(basename ? [`${basename}-poster`] : []),
        'poster',
        'folder',
        'cover',
        'movie',
      ];
    case 'fanart':
      return [...(basename ? [`${basename}-fanart`] : []), 'fanart', 'backdrop'];
    case 'logo':
      return ['clearlogo', 'logo'];
  }
}

export interface LocalArtwork {
  poster?: string;
  fanart?: string;
  logo?: string;
}

/**
 * Finds the usual media-center sidecar artwork next to a video file (movie,
 * `basename` given) or in a series folder (`basename` omitted). One `readdir`
 * per call, case-insensitive matching so `Poster.JPG` is found.
 */
export async function findLocalArtwork(
  dir: string,
  basename?: string,
): Promise<LocalArtwork> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return {};
  }
  const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]));

  const firstMatch = (kind: 'poster' | 'fanart' | 'logo'): string | undefined => {
    for (const name of candidateNames(kind, basename)) {
      for (const ext of EXTS) {
        const hit = byLower.get(`${name}.${ext}`.toLowerCase());
        if (hit) return path.join(dir, hit);
      }
    }
    return undefined;
  };

  const out: LocalArtwork = {};
  const poster = firstMatch('poster');
  if (poster) out.poster = poster;
  const fanart = firstMatch('fanart');
  if (fanart) out.fanart = fanart;
  const logo = firstMatch('logo');
  if (logo) out.logo = logo;
  return out;
}
