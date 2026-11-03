import type { Media } from '../../../core/services/api/media.service';
import type { BookDetail, BookEdition } from '../../../core/services/api/books.models';

/** The MD of a book: `book` is absent on other kinds, and a card handoff carries the list shape without editions. */
export type BookMedia = Media & { book: BookDetail };

export function asBookMedia(m: Media | null): BookMedia | null {
  return m?.type === 'book' && Array.isArray((m as Partial<BookMedia>).book?.editions) ? (m as BookMedia) : null;
}

/** `h:mm:ss` from an hour on, `m:ss` below. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** One file name per part of an edition: `Title.epub`, or `Title - 01.mp3` when the edition has several files. */
export function editionFileNames(title: string, e: BookEdition): string[] {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'book';
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
