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
  /** Lucide icon component (any of the @lucide/angular exports). */
  icon?: unknown;
  /** Optional tone applied to label + icon. */
  tone?: 'default' | 'danger';
  /** Action invoked when the user activates this row. */
  run: () => void;
  /** Disabled rows render greyed out and can't be activated. */
  disabled?: boolean;
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
@Injectable({ providedIn: 'root' })
export class CardActionsService {
  private readonly tv = inject(TvService);

  /** Actions advertised by the currently active card, or null if none. */
  readonly actions = signal<CardAction[] | null>(null);
  /** DOM anchor used by the panel for positioning. */
  readonly anchor = signal<HTMLElement | null>(null);
  /** Title shown at the top of the panel (typically the card title). */
  readonly title = signal<string>('');
  /** Whether the panel is currently open. */
  readonly open = signal(false);
  readonly hasActions = computed(() => (this.actions()?.length ?? 0) > 0);

  constructor() {
    if (typeof window === 'undefined') return;
    // The TV remote menu key is captured here once globally — directives only
    // register actions, they don't each install their own listener.
    if (this.tv.isTv()) {
      window.addEventListener('keydown', (e) => this.onTvKey(e), { capture: true });
    }
  }

  register(payload: { actions: CardAction[]; anchor: HTMLElement; title?: string }) {
    this.actions.set(payload.actions);
    this.anchor.set(payload.anchor);
    this.title.set(payload.title ?? '');
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
    if (!this.open() && (e.key === 'ContextMenu' || e.keyCode === 93 || e.keyCode === 82)) {
      if (!this.hasActions()) return;
      e.preventDefault();
      e.stopPropagation();
      this.show();
      return;
    }
    if (this.open() && (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'GoBack')) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }
}
