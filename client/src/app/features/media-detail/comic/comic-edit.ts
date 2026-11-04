import type { ComicDetail, ComicIssue, ComicIssuePatch, ComicVolumePatch } from '../../../core/services/api/comics.models';

const text = (f: FormData, k: string): string => ((f.get(k) as string | null) ?? '').trim();

/** An empty number field is null; `undefined` when the text is not a whole number in range. */
function whole(raw: string, lo: number, hi: number): number | null | undefined {
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
}

/** The volume fields that differ from `now`: only those are sent, so only those are locked. */
export function volumePatch(
  f: FormData,
  now: { title: string; overview: string | null; comic: Pick<ComicDetail, 'publisher' | 'startYear' | 'volume'> },
): ComicVolumePatch {
  const out: ComicVolumePatch = {};
  const title = text(f, 'title');
  if (title && title !== now.title) out.title = title;
  const overview = text(f, 'overview') || null;
  if (overview !== (now.overview || null)) out.overview = overview;
  const publisher = text(f, 'publisher') || null;
  if (publisher !== now.comic.publisher) out.publisher = publisher;
  const year = whole(text(f, 'startYear'), 1, 9999);
  if (year !== undefined && year !== now.comic.startYear) out.startYear = year;
  const volume = whole(text(f, 'volume'), 0, 9999);
  if (volume !== undefined && volume !== now.comic.volume) out.volume = volume;
  return out;
}

/** The issue fields that differ from `now`; null when a field holds a value the server would refuse. */
export function issuePatch(f: FormData, now: ComicIssue): ComicIssuePatch | null {
  const out: ComicIssuePatch = {};
  const number = text(f, 'number');
  if (!number) return null;
  if (number !== now.number) out.number = number;
  const sortRaw = text(f, 'sort');
  const sort = Number(sortRaw);
  if (sortRaw === '' || !Number.isFinite(sort) || Math.abs(sort) >= 10000) return null;
  if (sort !== now.sort) out.sort = sort;
  const kind = text(f, 'kind') as ComicIssue['kind'];
  if (kind !== now.kind) out.kind = kind;
  const title = text(f, 'title') || null;
  if (title !== (now.title || null)) out.title = title;
  const date = text(f, 'releaseDate') || null;
  if (date !== now.releaseDate) out.releaseDate = date;
  return out;
}
