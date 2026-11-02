import { describe, expect, it } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import { audioEditionFixture, bookDetailFixture, textEditionFixture } from '../../../core/services/api/books.fixtures';
import { asBookMedia, editionLabel, formatClock } from './book-media';

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

  it('labels an edition', () => {
    expect(editionLabel(audioEditionFixture)).toBe('Narrator One · M4B · en');
    expect(editionLabel(textEditionFixture)).toBe('EPUB · en');
    expect(editionLabel({ ...textEditionFixture, format: null, language: null })).toBe('#100');
  });
});
