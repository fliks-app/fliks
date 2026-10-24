import { Injectable, computed, inject, signal } from '@angular/core';
import { PartyApiService, type PartyReactionCatalog } from '../api/party-api.service';
import { ServerConfigService } from '../server-config.service';
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

/** The server-owned reaction catalog (fetched once) and this device's reaction bar. */
@Injectable({ providedIn: 'root' })
export class ReactionCatalogService {
  private readonly api = inject(PartyApiService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly catalog = signal<PartyReactionCatalog | null>(null);
  private readonly stored = signal<string[] | null>(readBar());

  readonly emojis = computed(() => this.catalog()?.reactions.map((r) => r.emoji) ?? []);
  readonly bar = computed(() => sanitizeBar(this.stored(), this.emojis(), this.catalog()?.defaults ?? []));
  private readonly animations = computed(
    () => new Map(this.catalog()?.reactions.map((r) => [r.emoji, this.serverConfig.resolveUrl(r.animation)])),
  );

  constructor() {
    this.api.reactionCatalog().then((c) => this.catalog.set(c), () => undefined);
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
