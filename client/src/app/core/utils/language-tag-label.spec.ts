import { signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAudioLabel, formatAudioParts, formatSubtitleLabel, formatSubtitleParts } from './player.utils';
import { buildSubtitleTracks, embeddedSubtitleTag } from './subtitle-tracks';

const NAMES: Record<string, Record<string, string>> = {
  fr: { 'language.es': 'Espagnol', 'language.pt': 'Portugais', 'language.zh': 'Chinois' },
  en: { 'language.es': 'Spanish', 'language.pt': 'Portuguese', 'language.zh': 'Chinese' },
};
const tr = (lang: string) =>
  ({
    instant: (key: string) => NAMES[lang][key] ?? key,
    currentLang: signal(lang),
    fallbackLang: signal('en'),
  }) as unknown as TranslateService;
const fr = tr('fr');
const en = tr('en');

const spa419 = { language: 'spa', languageTag: 'es-419', title: 'Latin American' };
const spaES = { language: 'spa', languageTag: 'es-ES' };

describe('language tag in labels', () => {
  it('names the variant in its dialect form', () => {
    const head = (s: { language: string; languageTag?: string }, t: TranslateService) =>
      formatSubtitleParts(s, t, 1).head;
    expect(head(spa419, fr)).toBe('Espagnol d’Amérique latine');
    expect(head(spaES, fr)).toBe('Espagnol d’Espagne');
    expect(head({ language: 'por', languageTag: 'pt-BR' }, fr)).toBe('Portugais brésilien');
    expect(head({ language: 'chi', languageTag: 'zh-Hant' }, fr)).toBe('Chinois traditionnel');
    expect(head(spa419, en)).toBe('Latin American Spanish');
    expect(head({ language: 'por', languageTag: 'pt-PT' }, en)).toBe('European Portuguese');
    expect(head({ language: 'chi', languageTag: 'zh-Hans' }, en)).toBe('Simplified Chinese');
  });

  it('keeps the plain head without a usable tag', () => {
    for (const languageTag of [undefined, '', 'es', 'fr-FR', 'garbage']) {
      expect(formatSubtitleParts({ language: 'spa', languageTag }, fr, 1).head).toBe('Espagnol');
    }
  });

  it('labels the one-line form too', () => {
    expect(formatSubtitleLabel({ language: 'spa', languageTag: 'es-ES' }, fr, 1)).toBe('Espagnol d’Espagne');
  });

  it('tells two dubs of one language apart', () => {
    const labels = [
      { language: 'por', languageTag: 'pt-BR', codec: 'eac3' },
      { language: 'por', languageTag: 'pt-PT', codec: 'eac3' },
    ].map((a) => formatAudioLabel(a, fr, 1));
    expect(labels).toEqual(['Portugais brésilien (EAC3)', 'Portugais européen (EAC3)']);
    expect(formatAudioParts({ language: 'por', languageTag: 'pt-PT' }, en, 1).head).toBe('European Portuguese');
    expect(formatAudioParts({ language: 'por' }, fr, 1).head).toBe('Portugais');
  });
});

describe('stream title next to a language tag', () => {
  const sub = (s: object, t = fr) => formatSubtitleParts(s as never, t, 1).sub;

  it('drops a title the region or script already says', () => {
    expect(sub(spa419)).toBe('');
    expect(sub(spa419, en)).toBe('');
    expect(sub({ language: 'por', languageTag: 'pt-BR', title: 'Brazilian' })).toBe('');
    expect(sub({ language: 'chi', languageTag: 'zh-Hant', title: 'Traditional' })).toBe('');
    expect(sub({ language: 'chi', languageTag: 'zh-Hans', title: 'simplifié' })).toBe('');
  });

  it('keeps any title that says more', () => {
    expect(sub({ ...spa419, title: 'Latin American (full)' })).toBe('Latin American (full)');
    expect(sub({ ...spaES, title: 'Castilian' })).toBe('Castilian');
  });

  it('keeps the title when no region is shown', () => {
    expect(sub({ language: 'spa', title: 'Latin American' })).toBe('Latin American');
    expect(sub({ language: 'spa', languageTag: 'es', title: 'Latin American' })).toBe('Latin American');
  });
});

describe('without Intl.DisplayNames', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the plain head and keeps the title', () => {
    vi.stubGlobal('Intl', { ...Intl, DisplayNames: undefined });
    const s = { ...spa419 };
    expect(formatSubtitleParts(s, fr, 1)).toEqual({ head: 'Espagnol', sub: 'Latin American' });
    expect(formatAudioLabel({ language: 'por', languageTag: 'pt-BR' }, fr, 1)).toBe('Portugais');
  });
});

describe('language tag plumbing', () => {
  const streams = [{ streamIndex: 10, languageTag: 'es-419' }, { streamIndex: 11 }];
  const row = (id: number, streamIndex: number | null, relativePath: string | null = null) =>
    ({ id, mediaFileId: 1, language: 'spa', streamIndex, relativePath });

  it('reads the tag from the stream with the same index, never for a sidecar', () => {
    expect(embeddedSubtitleTag(row(1, 10), streams)).toBe('es-419');
    expect(embeddedSubtitleTag(row(2, 11), streams)).toBeNull();
    expect(embeddedSubtitleTag(row(3, 10, 'a.srt'), streams)).toBeNull();
    expect(embeddedSubtitleTag(row(4, 10), undefined)).toBeNull();
  });

  it('carries the tag onto the built tracks without touching the language', () => {
    const tracks = buildSubtitleTracks([row(1, 10), row(2, 11)], 1, { hideBurnIn: false, streams });
    expect(tracks.map((t) => [t.key, t.language, t.languageTag])).toEqual([
      ['emb-10', 'es', 'es-419'],
      ['emb-11', 'es', null],
    ]);
  });
});
