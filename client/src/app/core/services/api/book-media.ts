import type { Media } from './media.service';
import type { BookDetail, BookEdition } from './books.models';
import { safeFileName } from '../../plugins/save-file.plugin';
import type { BookDownloadTarget } from '../download-manager.service';

/** The MD of a book: `book` is absent on other kinds, and a card handoff carries the list shape without editions. */
export type BookMedia = Media & { book: BookDetail };

export function asBookMedia(m: Media | null): BookMedia | null {
  return m?.type === 'book' && Array.isArray((m as Partial<BookMedia>).book?.editions) ? (m as BookMedia) : null;
}

/** One file name per part of an edition: `Title.epub`, or `Title - 01.mp3` when the edition has several files. */
export function editionFileNames(title: string, e: BookEdition): string[] {
  const base = safeFileName(title, 'book');
  const ext = e.format ? `.${e.format.toLowerCase()}` : '';
  const pad = String(e.fileIds.length).length;
  return e.fileIds.length === 1
    ? [`${base}${ext}`]
    : e.fileIds.map((_, i) => `${base} - ${String(i + 1).padStart(Math.max(2, pad), '0')}${ext}`);
}

/** What tells two editions of one work apart in a picker. */
export function editionLabel(e: BookEdition): string {
  const narrators = e.narrators.map((n) => n.name).join(', ');
  return [e.label, narrators, e.format?.toUpperCase(), e.language].filter(Boolean).join(' · ') || `#${e.id}`;
}

/** A text edition of these formats opens in the comic page reader. */
export const COMIC_ARCHIVES = ['cbz', 'cb7', 'cbr'];
const READABLE = ['epub', 'pdf', ...COMIC_ARCHIVES];

/** A text edition with a file the reader opens. */
export const readable = (e: BookEdition): boolean =>
  e.family === 'text' && e.itemId != null && e.fileIds.length > 0 && READABLE.includes(e.format?.toLowerCase() ?? '');

/** An audio item, or a text edition the reader opens, with a file to keep on the device. */
export const offlinable = (e: BookEdition): boolean =>
  e.itemId != null && e.hasFile && e.fileIds.length > 0 && (e.family === 'audio' || ['epub', 'pdf'].includes(e.format?.toLowerCase() ?? ''));

/** An edition with no cover of its own shows the work's poster. */
export function bookDownloadTarget(
  work: { mediaId: number; title: string; artist: string; posterUrl: string | null },
  e: BookEdition,
): BookDownloadTarget {
  return {
    mediaId: work.mediaId,
    itemId: e.itemId!,
    family: e.family,
    format: e.format?.toLowerCase() ?? null,
    fileIds: e.fileIds,
    title: work.title,
    posterUrl: e.coverUrl ?? work.posterUrl,
    artist: work.artist,
    coverUrl: e.coverUrl ?? work.posterUrl,
  };
}
