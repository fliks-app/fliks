import { normalizeText, searchEmojis, type EmojiEntry } from './emoji-search';

const entry = (emoji: string, label: string, tags: string[] = []): EmojiEntry => ({
  emoji,
  label,
  haystack: normalizeText([label, ...tags].join(' ')),
});

describe('emoji search', () => {
  const entries = [
    entry('🖕', 'doigt d’honneur', ['main', 'majeur']),
    entry('😀', 'visage souriant', ['sourire', 'émotion']),
    entry('🎬', 'clap', ['cinéma']),
  ];

  it('folds case, accents and punctuation', () => {
    expect(normalizeText('  Doigt d’Honneur, ÉMOTION ')).toBe('doigt d honneur emotion');
  });

  it('finds an emoji by its label whatever the apostrophe', () => {
    for (const q of ['doigt d honneur', "doigt d'honneur", 'DOIGT']) {
      expect(searchEmojis(entries, q).map((e) => e.emoji)).toEqual(['🖕']);
    }
  });

  it('matches tags without accents and requires every word', () => {
    expect(searchEmojis(entries, 'cinema').map((e) => e.emoji)).toEqual(['🎬']);
    expect(searchEmojis(entries, 'main sourire')).toEqual([]);
  });

  it('returns everything for an empty query', () => {
    expect(searchEmojis(entries, '  ')).toHaveLength(3);
  });
});
