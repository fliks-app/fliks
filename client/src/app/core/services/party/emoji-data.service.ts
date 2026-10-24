import { HttpBackend, HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
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
/** Skin-tone and hair components are not emojis on their own. */
const COMPONENT_GROUP = 'component';

/** The standard emoji set with its names in the UI language, fetched from the static `emoji-data/` assets on first use. */
@Injectable({ providedIn: 'root' })
export class EmojiDataService {
  private readonly http = new HttpClient(inject(HttpBackend));
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
    // Relative to <base href>, like the i18n files: a leading "/" breaks on TV (file://).
    const base = `emoji-data/${lang}`;
    const [emojis, messages] = await Promise.all([
      firstValueFrom(this.http.get<CompactEmoji[]>(`${base}/compact.json`)),
      firstValueFrom(this.http.get<Messages>(`${base}/messages.json`)),
    ]);
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
