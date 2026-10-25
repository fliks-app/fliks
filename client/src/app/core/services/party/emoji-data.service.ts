import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { type EmojiEntry, type EmojiGroup, normalizeText, searchEmojis } from './emoji-search';

interface CompactEmoji {
  unicode: string;
  label: string;
  tags?: string[];
  group?: number;
}

interface Messages {
  groups: { key: string; message: string; order: number }[];
}

const FALLBACK_LANG = 'en';
/** One lazy chunk per UI language, resolved by the bundler like any dependency and fetched only when the picker opens. */
const LOCALES: Record<string, () => Promise<[CompactEmoji[], Messages]>> = {
  de: () => Promise.all([import('emojibase-data/de/compact.json'), import('emojibase-data/de/messages.json')]).then(unwrap),
  en: () => Promise.all([import('emojibase-data/en/compact.json'), import('emojibase-data/en/messages.json')]).then(unwrap),
  es: () => Promise.all([import('emojibase-data/es/compact.json'), import('emojibase-data/es/messages.json')]).then(unwrap),
  fr: () => Promise.all([import('emojibase-data/fr/compact.json'), import('emojibase-data/fr/messages.json')]).then(unwrap),
  it: () => Promise.all([import('emojibase-data/it/compact.json'), import('emojibase-data/it/messages.json')]).then(unwrap),
  pt: () => Promise.all([import('emojibase-data/pt/compact.json'), import('emojibase-data/pt/messages.json')]).then(unwrap),
};

function unwrap([emojis, messages]: [{ default: unknown }, { default: unknown }]): [CompactEmoji[], Messages] {
  return [emojis.default as CompactEmoji[], messages.default as Messages];
}
/** Skin-tone and hair components are not emojis on their own. */
const COMPONENT_GROUP = 'component';

/** The standard emoji set with its names in the UI language, loaded on first use. */
@Injectable({ providedIn: 'root' })
export class EmojiDataService {
  private readonly translate = inject(TranslateService);
  private readonly loaded = signal<{ lang: string; groups: EmojiGroup[] } | null>(null);
  private loading: { lang: string; done: Promise<void> } | null = null;

  readonly groups = computed(() => this.loaded()?.groups ?? []);
  private readonly entries = computed(() => this.groups().flatMap((g) => g.emojis));
  /** Null until the data is loaded. */
  readonly known = computed(() => (this.loaded() ? new Set(this.entries().map((e) => e.emoji)) : null));
  private readonly labels = computed(() => new Map(this.entries().map((e) => [e.emoji, e.label])));

  /** Fetches the current UI language once (English when it is unavailable); a failure is retried by the next call. */
  load(): Promise<void> {
    const lang = this.translate.currentLang() || this.translate.fallbackLang() || FALLBACK_LANG;
    if (this.loaded()?.lang === lang) return Promise.resolve();
    if (this.loading?.lang === lang) return this.loading.done;
    const done = this.fetchOrFallback(lang)
      .then(
        (groups) => this.loaded.set({ lang, groups }),
        () => undefined,
      )
      .finally(() => (this.loading = null));
    this.loading = { lang, done };
    return done;
  }

  label(emoji: string): string | undefined {
    return this.labels().get(emoji);
  }

  search(query: string): EmojiEntry[] {
    return searchEmojis(this.entries(), query);
  }

  private async fetchOrFallback(lang: string): Promise<EmojiGroup[]> {
    try {
      return await this.fetch(lang);
    } catch (e) {
      if (lang === FALLBACK_LANG) throw e;
      return this.fetch(FALLBACK_LANG);
    }
  }

  private async fetch(lang: string): Promise<EmojiGroup[]> {
    const loader = LOCALES[lang];
    if (!loader) throw new Error(`no emoji data for ${lang}`);
    const [emojis, messages] = await loader();
    return messages.groups
      .filter((g) => g.key !== COMPONENT_GROUP)
      .map((g) => ({
        key: g.key,
        label: g.message,
        emojis: emojis
          .filter((e) => e.group === g.order)
          .map((e) => ({ emoji: e.unicode, label: e.label, haystack: normalizeText([e.label, ...(e.tags ?? [])].join(' ')) })),
      }));
  }
}
