import type { UiContribution } from '@fliks/plugin-ui';

/** Core's own `media.actions` as contributions, merged with plugin ones by weight/id. Gates `when` can't express
 *  (an OR, non-permission facts) stay in `media-info-header.ts`; label/icon toggles live in `displayLabelKey`/`displayIcon`. */
/** Section boundaries as weight bands (personal, acquisition, editing, maintenance, destructive), so plugin contributions group by their declared weight. */
export function sectionOf(weight: number): string {
  if (weight < 500) return 'personal';
  if (weight < 1000) return 'edit';
  return 'advanced';
}

export const CORE_MEDIA_ACTIONS: readonly UiContribution[] = [
  {
    id: 'core.like',
    slot: 'media.actions',
    weight: 120,
    labelKey: 'media_detail.like',
    icon: 'heart',
    action: { kind: 'action', actionId: 'media.toggle-like' },
  },
  {
    id: 'core.download',
    slot: 'media.actions',
    weight: 140,
    labelKey: 'downloads.download',
    icon: 'download',
    when: ['!isTv', 'hasFiles', 'mediaType:movie'],
    action: { kind: 'action', actionId: 'media.download' },
  },
  {
    id: 'core.download_series',
    slot: 'media.actions',
    weight: 140,
    labelKey: 'downloads.download_series',
    icon: 'download',
    when: ['!isTv', 'mediaType:series'],
    action: { kind: 'action', actionId: 'media.download-series' },
  },
  {
    id: 'core.auto_download_group',
    slot: 'media.actions',
    weight: 141,
    labelKey: 'downloads.auto_rule',
    icon: 'download',
    when: ['!isTv', 'mediaType:series'],
    action: { kind: 'submenu' },
    children: ([0, 3, 5, 10] as const).map((n, i) => ({
      id: `core.auto_download_${n}`,
      slot: 'media.actions' as const,
      weight: i,
      labelKey: n ? 'downloads.auto_next' : 'downloads.auto_off',
      action: { kind: 'action' as const, actionId: `media.auto-download-${n}` },
    })),
  },
  // ── Rows a card owns ────────────────────────────────────────────────────
  // Play/Open say `surface:card`: on a detail page you are already there.
  {
    id: 'core.play',
    slot: 'media.actions',
    weight: 50,
    labelKey: 'media_card.action_play',
    icon: 'play',
    when: ['surface:card'],
    action: { kind: 'action', actionId: 'media.play' },
  },
  {
    id: 'core.open',
    slot: 'media.actions',
    weight: 60,
    labelKey: 'media_card.action_open',
    icon: 'external-link',
    when: ['surface:card'],
    action: { kind: 'action', actionId: 'media.open' },
  },
  {
    id: 'core.add_to_playlist',
    slot: 'media.actions',
    weight: 150,
    labelKey: 'media_detail.add_to_list',
    icon: 'list-plus',
    action: { kind: 'action', actionId: 'media.add-to-playlist' },
  },
  {
    // The series-scoped row above covers a series; this one takes everything
    // else, so the two are never both offered.
    id: 'core.toggle_watched',
    slot: 'media.actions',
    weight: 210,
    labelKey: 'media_card.mark_watched',
    icon: 'eye',
    when: ['!mediaType:series'],
    action: { kind: 'action', actionId: 'media.toggle-watched' },
  },
  {
    // Groups the two rows that re-read a title from its provider.
    id: 'core.metadata_group',
    slot: 'media.actions',
    weight: 750,
    labelKey: 'media_detail.metadata_group',
    icon: 'database',
    action: { kind: 'submenu' },
    children: [
    {
      // `!isEpisode`: identity is title-level, like the profile/library entries.
      id: 'core.identify',
      slot: 'media.actions',
      weight: 10,
      labelKey: 'media_detail.identify',
      icon: 'search',
      when: ['isAdmin', '!isEpisode'],
      action: { kind: 'action', actionId: 'media.identify' },
    },
    {
      id: 'core.refresh_metadata',
      slot: 'media.actions',
      weight: 20,
      labelKey: 'media_detail.refresh_metadata',
      icon: 'rotate-ccw',
      when: ['isAdmin', 'identified'],
      action: { kind: 'action', actionId: 'media.refresh-metadata' },
    },
    ],
  },
  {
    // Everything that reconfigures or removes the title, one fold away from a
    // menu that is mostly used for the rows above it.
    id: 'core.advanced_group',
    slot: 'media.actions',
    weight: 1100,
    labelKey: 'media_detail.advanced_group',
    icon: 'sliders-horizontal',
    action: { kind: 'submenu' },
    children: [
    {
      id: 'core.tracking',
      slot: 'media.actions',
      weight: 5,
      labelKey: 'tracking.menu_item',
      icon: 'list-checks',
      when: ['isMonitored'],
      action: { kind: 'action', actionId: 'media.open-tracking' },
    },
    {
      id: 'core.analyze',
      slot: 'media.actions',
      weight: 10,
      labelKey: 'media_detail.analyze',
      icon: 'scan-line',
      when: ['isAdmin', 'surface:detail'],
      action: { kind: 'action', actionId: 'media.analyze' },
    },
    {
      // `!isEpisode`: profile/library assignment is title-level, not per-episode.
      id: 'core.edit_profiles',
      slot: 'media.actions',
      weight: 20,
      labelKey: 'media_detail.edit_profiles',
      icon: 'settings',
      when: ['hasPermission:media.edit', '!isEpisode', 'surface:detail'],
      action: { kind: 'action', actionId: 'media.edit-profiles' },
    },
    {
      id: 'core.edit_library',
      slot: 'media.actions',
      weight: 30,
      labelKey: 'media_detail.edit_library',
      icon: 'folder',
      when: ['hasPermission:media.edit', '!isEpisode', 'surface:detail'],
      action: { kind: 'action', actionId: 'media.edit-library' },
    },
    {
      id: 'core.toggle_monitored',
      slot: 'media.actions',
      weight: 40,
      labelKey: 'media_detail.monitor',
      icon: 'eye',
      when: ['isAdmin'],
      action: { kind: 'action', actionId: 'media.toggle-monitored' },
    },
    {
      id: 'core.delete',
      slot: 'media.actions',
      weight: 50,
      labelKey: 'media_detail.delete_from_library',
      icon: 'trash-2',
      tone: 'danger',
      confirmKey: 'media_detail.confirm_delete',
      when: ['hasPermission:media.delete'],
      action: { kind: 'action', actionId: 'media.delete' },
    },
    ],
  },
  {
    // Drops the media from the list being browsed, not from the library.
    id: 'core.remove',
    slot: 'media.actions',
    weight: 1350,
    labelKey: 'media_card.remove_from_list',
    icon: 'trash-2',
    tone: 'danger',
    when: ['surface:card'],
    action: { kind: 'action', actionId: 'media.remove' },
  },
  {
    id: 'core.recommend',
    slot: 'media.actions',
    weight: 100,
    labelKey: 'recommend.menu_item',
    icon: 'user-plus',
    when: ['!isTv'],
    action: { kind: 'action', actionId: 'media.recommend' },
  },
  {
    id: 'core.mark_series_watched',
    slot: 'media.actions',
    weight: 200,
    labelKey: 'media_detail.mark_series_watched',
    icon: 'check',
    when: ['mediaType:series', '!isEpisode'],
    action: { kind: 'action', actionId: 'media.toggle-series-watched' },
  },
  {
    id: 'core.request_media',
    slot: 'media.actions',
    weight: 400,
    labelKey: 'media_detail.request_media',
    icon: 'clipboard-list',
    when: ['hasPermission:requests.create', '!hasPermission:media.create'],
    action: { kind: 'action', actionId: 'media.request' },
  },
  // Subtitles are per-file (movie or episode): an OR, expressed as two contributions on one actionId so every surface gets the gate.
  {
    id: 'core.edit_subtitles',
    slot: 'media.actions',
    weight: 700,
    labelKey: 'media_detail.edit_subtitles',
    icon: 'captions',
    when: ['mediaType:movie', 'surface:detail'],
    action: { kind: 'action', actionId: 'media.edit-subtitles' },
  },
  {
    id: 'core.request_deletion',
    slot: 'media.actions',
    weight: 1400,
    labelKey: 'media_detail.request_deletion',
    icon: 'trash-2',
    tone: 'danger',
    confirmKey: 'media_detail.request_deletion_confirm',
    // Pending deletion request is per-title async state, not a permission, so it can't be a `when` predicate; full guard in media-info-header.ts.
    action: { kind: 'action', actionId: 'media.request-deletion' },
  },
];
