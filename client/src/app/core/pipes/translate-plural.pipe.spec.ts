import { describe, expect, it } from 'vitest';
import type { TranslateService } from '@ngx-translate/core';
import { translatePlural } from './translate-plural.pipe';

const fake = (lang: string) =>
  ({
    currentLang: () => lang,
    fallbackLang: () => 'en',
    instant: (key: string, p: { count: number }) => `${key}:${p.count}`,
  }) as unknown as TranslateService;

describe('translatePlural', () => {
  it('follows each language rule for zero and one', () => {
    expect(translatePlural(fake('fr'), 'k', 0)).toBe('k_one:0');
    expect(translatePlural(fake('fr'), 'k', 1)).toBe('k_one:1');
    expect(translatePlural(fake('fr'), 'k', 2)).toBe('k_other:2');
    expect(translatePlural(fake('en'), 'k', 0)).toBe('k_other:0');
    expect(translatePlural(fake('en'), 'k', 1)).toBe('k_one:1');
  });
});
