import * as fs from 'fs/promises';
import * as path from 'path';

const EXTS = ['jpg', 'jpeg', 'png', 'webp'];

/** Candidate basenames (without extension), in precedence order. `basenameOnly`
 *  drops every generic name: a shared directory (a root movie's library root)
 *  must not match another title's `poster.jpg`/`folder.jpg`/etc. */
function candidateNames(
  kind: 'poster' | 'fanart' | 'logo',
  basename?: string,
  basenameOnly?: boolean,
): string[] {
  switch (kind) {
    case 'poster':
      return basenameOnly
        ? basename ? [`${basename}-poster`] : []
        : [...(basename ? [`${basename}-poster`] : []), 'poster', 'folder', 'cover', 'movie'];
    case 'fanart':
      return basenameOnly
        ? basename ? [`${basename}-fanart`] : []
        : [...(basename ? [`${basename}-fanart`] : []), 'fanart', 'backdrop'];
    case 'logo':
      return basenameOnly ? [] : ['clearlogo', 'logo'];
  }
}

export interface LocalArtwork {
  poster?: string;
  fanart?: string;
  logo?: string;
}

/** Finds the usual sidecar artwork next to a video file (movie, `basename` given) or
 *  in a series folder (omitted). One `readdir`, case-insensitive matching.
 *  `basenameOnly` restricts matches to the `<basename>-poster`/`<basename>-fanart`
 *  form, for a directory shared with other titles (a root-level movie's library root). */
export async function findLocalArtwork(
  dir: string,
  basename?: string,
  opts: { basenameOnly?: boolean } = {},
): Promise<LocalArtwork> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return {};
  }
  const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]));

  const firstMatch = (kind: 'poster' | 'fanart' | 'logo'): string | undefined => {
    for (const name of candidateNames(kind, basename, opts.basenameOnly)) {
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
