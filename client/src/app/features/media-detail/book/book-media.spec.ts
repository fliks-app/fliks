import { describe, expect, it } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import { audioEditionFixture, bookDetailFixture, textEditionFixture } from '../../../core/services/api/books.fixtures';
import { asBookMedia, editionFileNames, editionLabel, formatClock } from './book-media';

describe('book-media', () => {
  it('narrows only a book that carries its detail', () => {
    const book = { id: 1, type: 'book', book: bookDetailFixture } as unknown as Media;
    expect(asBookMedia(book)).toBe(book);
    expect(asBookMedia({ ...book, book: undefined } as unknown as Media)).toBeNull();
    expect(asBookMedia({ ...book, book: { authors: [] } } as unknown as Media)).toBeNull();
    expect(asBookMedia({ ...book, type: 'movie' } as unknown as Media)).toBeNull();
    expect(asBookMedia(null)).toBeNull();
  });

  it('formats a clock', () => {
    expect(formatClock(59)).toBe('0:59');
    expect(formatClock(1800)).toBe('30:00');
    expect(formatClock(36000 + 61)).toBe('10:01:01');
  });

  it('names the files of an edition', () => {
    const e = { ...textEditionFixture, format: 'EPUB', fileIds: [1] };
    expect(editionFileNames('A/B: C', e)).toEqual(['A B C.epub']);
    expect(editionFileNames('T', { ...e, format: 'mp3', fileIds: [1, 2] })).toEqual(['T - 01.mp3', 'T - 02.mp3']);
    expect(editionFileNames('', { ...e, format: null })).toEqual(['book']);
  });

  it('labels an edition', () => {
    expect(editionLabel(audioEditionFixture)).toBe('Narrator One · M4B · en');
    expect(editionLabel(textEditionFixture)).toBe('EPUB · en');
    expect(editionLabel({ ...textEditionFixture, format: null, language: null })).toBe('#100');
  });
});
