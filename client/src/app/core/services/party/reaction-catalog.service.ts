import { moveItemInArray } from '@angular/cdk/drag-drop';
import { Injectable, computed, inject, signal } from '@angular/core';
import { PartyApiService, type PartyReactionCatalog } from '../api/party-api.service';
import { ServerConfigService } from '../server-config.service';
import { EmojiDataService } from './emoji-data.service';
import { sanitizeBar, toggleBar } from './reaction-bar';

const BAR_KEY = 'party.reactionBar';

function readBar(): string[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(BAR_KEY) ?? 'null');
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : null;
  } catch {
    return null;
  }
}

/** The server's animated reactions and default bar (fetched once), and this device's reaction bar. */
@Injectable({ providedIn: 'root' })
export class ReactionCatalogService {
  private readonly api = inject(PartyApiService);
  private readonly emojiData = inject(EmojiDataService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly catalog = signal<PartyReactionCatalog | null>(null);
  private readonly stored = signal<string[] | null>(readBar());

  readonly bar = computed(() => sanitizeBar(this.stored(), this.emojiData.known(), this.catalog()?.defaults ?? []));
  private readonly animations = computed(
    () => new Map(Object.entries(this.catalog()?.animations ?? {}).map(([e, url]) => [e, this.serverConfig.resolveUrl(url)])),
  );

  private loading: Promise<void> | null = null;

  /** Fetches the catalog once; a failed fetch is retried by the next call instead of leaving the bar empty. */
  load(): Promise<void> {
    if (this.catalog()) return Promise.resolve();
    this.loading ??= this.api.reactionCatalog().then(
      (c) => this.catalog.set(c),
      () => {
        this.loading = null;
      },
    );
    return this.loading;
  }

  hasAnimation(emoji: string): boolean {
    return this.animations().has(emoji);
  }

  animation(emoji: string): string | null {
    return this.animations().get(emoji) ?? null;
  }

  /** False when the change is refused (bar full, or last emoji). */
  toggle(emoji: string): boolean {
    const next = toggleBar(this.bar(), emoji);
    if (next) this.save(next);
    return next !== null;
  }

  /** Moves the bar emoji at `from` to `to` (drag and drop in the settings). */
  move(from: number, to: number): void {
    const bar = [...this.bar()];
    moveItemInArray(bar, from, to);
    this.save(bar);
  }

  reset(): void {
    this.save(null);
  }

  private save(bar: string[] | null): void {
    this.stored.set(bar);
    try {
      if (bar) localStorage.setItem(BAR_KEY, JSON.stringify(bar));
      else localStorage.removeItem(BAR_KEY);
    } catch {
      // storage unavailable: the choice lasts for this session
    }
  }
}
