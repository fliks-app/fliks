import type { UiContribution } from '../../../core/plugin-ui/contribution.types';

/**
 * Core's own `card.actions` items, expressed as contributions so they merge
 * with plugin contributions through the same weight/id sort instead of a
 * fixed sequence of `.push()` calls. Gating this domain needs almost none of
 * the closed `when` vocabulary — "has a link", "is playable", "is
 * dismissable" aren't predicates in it — so the real gate for every id here
 * lives in `media-card.ts`'s `extraGuards`, documented there. Weights leave
 * 600-800 open: that is exactly where `extraActions` (the one input this
 * slot replaces) still splices in, between the watched toggle and Remove.
 *
 * `core.toggle_watched` swaps its own label/icon by live state (watched vs
 * not) — cosmetic, so the swap lives in `media-card.ts`, not here.
 */
export const CORE_CARD_ACTIONS: readonly UiContribution[] = [
  {
    id: 'core.play',
    slot: 'card.actions',
    weight: 100,
    labelKey: 'media_card.action_play',
    icon: 'play',
    action: { kind: 'action', actionId: 'card.play' },
  },
  {
    id: 'core.open',
    slot: 'card.actions',
    weight: 200,
    labelKey: 'media_card.action_open',
    icon: 'external-link',
    action: { kind: 'action', actionId: 'card.open' },
  },
  {
    id: 'core.add_to_playlist',
    slot: 'card.actions',
    weight: 300,
    labelKey: 'playlists.add_to_playlist',
    icon: 'list-plus',
    action: { kind: 'action', actionId: 'card.add-to-playlist' },
  },
  {
    id: 'core.recommend',
    slot: 'card.actions',
    weight: 400,
    labelKey: 'recommend.menu_item',
    icon: 'user-plus',
    when: ['!isTv'],
    action: { kind: 'action', actionId: 'card.recommend' },
  },
  {
    id: 'core.toggle_watched',
    slot: 'card.actions',
    weight: 500,
    labelKey: 'media_card.mark_watched',
    icon: 'eye',
    action: { kind: 'action', actionId: 'card.toggle-watched' },
  },
  {
    id: 'core.remove',
    slot: 'card.actions',
    weight: 900,
    labelKey: 'media_card.remove_from_list',
    icon: 'trash-2',
    tone: 'danger',
    action: { kind: 'action', actionId: 'card.remove' },
  },
];
