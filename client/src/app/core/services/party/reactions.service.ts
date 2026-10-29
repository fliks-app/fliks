import { moveItemInArray } from '@angular/cdk/drag-drop';
import { Injectable, computed, inject, signal } from '@angular/core';
import { PartyApiService, type PartyReactionCatalog } from '../api/party-api.service';
import { ServerConfigService } from '../server-config.service';
import { EmojiDataService } from './emoji-data.service';
import { readFlag, readStored, writeFlag, writeStored } from './local-flag';
import { sanitizeBar, toggleBar } from './reaction-bar';

const BAR_KEY = 'party.reactionBar';
const ENABLED_KEY = 'party.reactionsEnabled';
const DOCK_KEY = 'party.reactionDock';

function readBar(): string[] | null {
  try {
    const v: unknown = JSON.parse(readStored(BAR_KEY) ?? 'null');
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : null;
  } catch {
    return null;
  }
}

/** The server's reaction catalog (fetched once), and this device's reaction bar and settings. */
@Injectable({ providedIn: 'root' })
export class ReactionsService {
  private readonly api = inject(PartyApiService);
  private readonly emojiData = inject(EmojiDataService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly catalog = signal<PartyReactionCatalog | null>(null);
  private readonly stored = signal<string[] | null>(readBar());

  readonly bar = computed(() => sanitizeBar(this.stored(), this.emojiData.known(), this.catalog()?.defaults ?? []));
  private readonly animations = computed(
    () => new Map(Object.entries(this.catalog()?.animations ?? {}).map(([e, url]) => [e, this.serverConfig.resolveUrl(url)])),
  );
  private readonly animationPaths = computed(() => new Map(Object.entries(this.catalog()?.animations ?? {})));

  /** Master switch: off hides the dock and the reactions rising over the video. */
  readonly enabled = signal(readFlag(ENABLED_KEY, true));
  /** The emoji the keyboard last sat on in the row, where ArrowDown lands again. */
  lastFocused: string | null = null;
  /** The floating reaction button over the video. */
  readonly dock = signal(readFlag(DOCK_KEY, true));

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

  animation(emoji: string): string | null {
    return this.animations().get(emoji) ?? null;
  }

  /** The server-relative path of the animated asset, for a host the caller picks (the cast receiver's). */
  animationPath(emoji: string): string | null {
    return this.animationPaths().get(emoji) ?? null;
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

  setEnabled(on: boolean): void {
    this.enabled.set(on);
    writeFlag(ENABLED_KEY, on);
  }

  setDock(on: boolean): void {
    this.dock.set(on);
    writeFlag(DOCK_KEY, on);
  }

  private save(bar: string[] | null): void {
    this.stored.set(bar);
    writeStored(BAR_KEY, bar && JSON.stringify(bar));
  }
}
