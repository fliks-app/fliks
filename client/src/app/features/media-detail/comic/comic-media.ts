import type { Media } from '../../../core/services/api/media.service';
import type { ComicDetail, ComicIssue } from '../../../core/services/api/comics.models';

/** The MD of a comic volume: `comic` is absent on other kinds, and a card handoff carries the list shape without issues. */
export type ComicMedia = Media & { comic: ComicDetail };

export function asComicMedia(m: Media | null): ComicMedia | null {
  return m?.type === 'comic' && Array.isArray((m as Partial<ComicMedia>).comic?.issues) ? (m as ComicMedia) : null;
}

/** The issue a read button opens: the one in progress, else the first unfinished, else the first, among main issues with a file (annuals when there are none). */
export function nextIssue(issues: ComicIssue[]): ComicIssue | null {
  const withFile = issues.filter((i) => i.mediaFileId != null);
  const main = withFile.filter((i) => !i.annual);
  const pool = main.length ? main : withFile;
  return pool.find((i) => !i.finished && i.progression != null) ?? pool.find((i) => !i.finished) ?? pool[0] ?? null;
}
