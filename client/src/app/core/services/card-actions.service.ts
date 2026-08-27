import { Injectable, computed, inject, signal } from '@angular/core';
import { TvService } from './tv.service';

/**
 * One row in the actions panel that pops up for a card.
 * Provide a translation key (preferred) or a literal label, plus a callback.
 */
export interface CardAction {
  /** Translation key — resolved by the panel component. */
  labelKey?: string;
  /** Pre-translated label (used when no `labelKey` is provided). */
  label?: string;
  /**
   * Lucide icon name for the leading glyph — a `card.actions` contribution
   * can carry any name. Resolved by the panel component against a curated
   * whitelist; unrecognised names fall back to a generic glyph, never blank.
   */
  icon?: string;
  /** Optional tone applied to label + icon. */
  tone?: 'default' | 'danger';
  /** Action invoked when the user activates this row. */
  run: () => void;
  /** Disabled rows render greyed out and can't be activated. */
  disabled?: boolean;
  /** Rows are grouped in declaration order and a rule is drawn wherever this
   *  changes. Any name works: it labels nothing, it only marks the boundary. */
  section?: string;
  /** Renders the row as a link instead of a button. `run` is ignored. */
  route?: string;
}

/**
 * Brokers the "card → contextual actions" UX across TV and mobile.
 *
 * Producers (typically a card component or its consumers) declare a list of
 * {@link CardAction} via the `appCardActions` directive. The directive wires
 * up the right gesture per platform:
 *
 *   • Android TV   →  remote menu button (KEYCODE_MENU / `ContextMenu`)
 *   • Mobile native → long-press (touchstart held ≥ 500 ms)
 *   • Desktop      → no automatic trigger (cards keep their inline buttons)
 *
 * When triggered, the globally-mounted `<app-card-actions-panel>` shows the
 * actions, anchored to the originating card on TV and as a bottom sheet on
 * mobile. The same registry powers both presentations so each card declares
 * its actions once and the platform picks the right surface.
 */
/**
 * How the anchored dropdown is positioned relative to its anchor:
 *   • `card` — dropdown drops centered below the anchor (TV menu key, etc.).
 *     Typically used when the anchor is the whole card figure.
 *   • `button` — dropdown's right edge aligns with the anchor's right edge,
 *     drops just below it. Used by the desktop `⋯` button so the menu appears
 *     under the button and overlays the card body.
 */
export type CardActionsPlacement = 'card' | 'button';

@Injectable({ providedIn: 'root' })
export class CardActionsService {
  private readonly tv = inject(TvService);

  /** Actions advertised by the currently active card, or null if none. */
  readonly actions = signal<CardAction[] | null>(null);
  /** DOM anchor used by the panel for positioning. */
  readonly anchor = signal<HTMLElement | null>(null);
  /** Placement strategy for the dropdown relative to its anchor. */
  readonly placement = signal<CardActionsPlacement>('card');
  /** Title shown at the top of the panel (typically the card title). */
  readonly title = signal<string>('');
  /** Poster/thumbnail shown in the panel header. Null = none. */
  readonly imageUrl = signal<string | null>(null);
  /** Aspect ratio of the header thumbnail — portrait posters (movie/series/
   *  season) vs landscape stills (episode). */
  readonly imageAspect = signal<'portrait' | 'landscape'>('portrait');
  /** Secondary line under the title in the panel header (e.g. year). */
  readonly subtitle = signal<string>('');
  /** Whether the panel is currently open. */
  readonly open = signal(false);
  readonly hasActions = computed(() => (this.actions()?.length ?? 0) > 0);

  constructor() {
    if (typeof window === 'undefined') return;
    // Attach unconditionally; gate on tv.isTv() inside the handler. The
    // TvService's signal can flip after this service is constructed (early
    // injection chain), so a one-shot check at construction time misses
    // the moment when the listener is actually needed.
    window.addEventListener('keydown', (e) => this.onTvKey(e), { capture: true });
    window.addEventListener('contextmenu', (e) => {
      if (this.tv.isTv()) e.preventDefault();
    }, { capture: true });
  }

  register(payload: {
    actions: CardAction[];
    anchor: HTMLElement;
    title?: string;
    imageUrl?: string | null;
    imageAspect?: 'portrait' | 'landscape';
    subtitle?: string;
    placement?: CardActionsPlacement;
  }) {
    this.actions.set(payload.actions);
    this.anchor.set(payload.anchor);
    this.title.set(payload.title ?? '');
    this.imageUrl.set(payload.imageUrl ?? null);
    this.imageAspect.set(payload.imageAspect ?? 'portrait');
    this.subtitle.set(payload.subtitle ?? '');
    this.placement.set(payload.placement ?? 'card');
  }

  /**
   * Clear if the calling anchor still owns the registry. Avoids the race where
   * focus moves between cards: the new card's `register` runs before the old
   * card's `clear`, and we don't want the late `clear` to wipe the new state.
   */
  clear(anchor: HTMLElement) {
    if (this.anchor() === anchor && !this.open()) {
      this.actions.set(null);
      this.anchor.set(null);
      this.title.set('');
      this.imageUrl.set(null);
      this.imageAspect.set('portrait');
      this.subtitle.set('');
    }
  }

  show() {
    if (this.hasActions()) this.open.set(true);
  }

  close() {
    this.open.set(false);
    queueMicrotask(() => this.anchor()?.focus());
  }

  private onTvKey(e: KeyboardEvent) {
    if (!this.tv.isTv()) return;
    // ContextMenu/Menu (82/93) is the standard. BrowserFavorites covers
    // remotes that ship a Bookmark key instead — Android dispatches it as
    // the BrowserFavorites web key (keyCode 0).
    if (
      !this.open() &&
      (e.key === 'ContextMenu' ||
        e.key === 'BrowserFavorites' ||
        e.keyCode === 93 ||
        e.keyCode === 82)
    ) {
      if (!this.hasActions()) return;
      e.preventDefault();
      e.stopPropagation();
      this.show();
      return;
    }
    // Tizen's Return key (10009 / XF86Back) must close this popup rather than
    // reach the app-shell back handler, which would navigate away or exit.
    if (
      this.open() &&
      (e.key === 'Escape' ||
        e.key === 'Backspace' ||
        e.key === 'GoBack' ||
        e.key === 'XF86Back' ||
        e.keyCode === 10009)
    ) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

}
