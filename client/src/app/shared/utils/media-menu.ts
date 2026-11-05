import type { CardAction, CardActionsService } from '../../core/services/card-actions.service';
import type { ResolvedMenuRow } from '../../core/plugin-ui/resolve-menu-contributions';
import { sectionOf } from '../components/detail-hero/core-media-actions';

/** A resolved menu row as a card-actions panel row; `adapt` overrides label, icon or disabled per row, children included. */
export function toCardAction(r: ResolvedMenuRow, adapt?: (r: ResolvedMenuRow) => Partial<CardAction>): CardAction {
  return {
    labelKey: r.labelKey,
    icon: r.icon,
    tone: r.tone,
    section: sectionOf(r.weight),
    ...(r.route ? { route: r.route } : {}),
    ...(r.children?.length ? { children: r.children.map((c) => toCardAction(c, adapt)) } : {}),
    run: () => r.run?.(),
    ...adapt?.(r),
  };
}

/** Opens the panel under the clicked "more" button; nothing when no row survived. */
export function openMediaMenu(
  cardActions: CardActionsService,
  rows: readonly ResolvedMenuRow[],
  anchor: HTMLElement,
  meta: { title: string; subtitle?: string; imageUrl: string | null; imageAspect?: 'portrait' | 'landscape' },
  adapt?: (r: ResolvedMenuRow) => Partial<CardAction>,
): void {
  if (!rows.length) return;
  cardActions.register({ actions: rows.map((r) => toCardAction(r, adapt)), anchor, placement: 'button', ...meta });
  cardActions.show();
}
