import type { UiContribution } from '../../../core/plugin-ui/contribution.types';

/**
 * Core's own `media.actions` items, expressed as contributions so they merge
 * with plugin contributions through the same weight/id sort instead of being
 * a fixed sequence of `@if` blocks. `when` encodes every part of the
 * pre-refactor gate that the closed vocabulary can express; the handful that
 * can't (an OR, or a fact that isn't a permission) stay as an extra guard in
 * `media-info-header.ts`, documented there.
 *
 * Two rows (`core.mark_series_watched`, `core.toggle_monitored`) toggle their
 * own label/icon by live state — cosmetic, so the swap lives in the
 * component's `displayLabelKey`/`displayIcon`, not here.
 */
export const CORE_MEDIA_ACTIONS: readonly UiContribution[] = [
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
    id: 'core.tracking',
    slot: 'media.actions',
    weight: 300,
    labelKey: 'tracking.menu_item',
    icon: 'list-checks',
    when: ['isMonitored'],
    action: { kind: 'action', actionId: 'media.open-tracking' },
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
  {
    id: 'core.grab_best',
    slot: 'media.actions',
    weight: 500,
    labelKey: 'media_detail.grab_best',
    icon: 'download',
    when: ['hasPermission:media.grab', '!mediaType:series', 'hasQualityProfile'],
    action: { kind: 'action', actionId: 'media.grab-best' },
  },
  {
    id: 'core.search_releases',
    slot: 'media.actions',
    weight: 600,
    labelKey: 'media_detail.search_releases',
    icon: 'search',
    when: ['hasPermission:media.grab', '!mediaType:series', 'hasQualityProfile'],
    action: { kind: 'action', actionId: 'media.search-releases' },
  },
  {
    // `!isEpisode`: profile/library assignment is title-level, not
    // per-episode — the pre-refactor episode header never bound
    // `canEditProfiles` at all (always false), for the same reason.
    id: 'core.edit_profiles',
    slot: 'media.actions',
    weight: 700,
    labelKey: 'media_detail.edit_profiles',
    icon: 'settings',
    when: ['hasPermission:media.edit', '!isEpisode'],
    action: { kind: 'action', actionId: 'media.edit-profiles' },
  },
  {
    id: 'core.edit_library',
    slot: 'media.actions',
    weight: 800,
    labelKey: 'media_detail.edit_library',
    icon: 'folder',
    when: ['hasPermission:media.edit', '!isEpisode'],
    action: { kind: 'action', actionId: 'media.edit-library' },
  },
  {
    id: 'core.edit_subtitles',
    slot: 'media.actions',
    weight: 900,
    labelKey: 'media_detail.edit_subtitles',
    icon: 'captions',
    // Original gate is `mediaType:movie OR isEpisode` — an OR, so it can't
    // live in `when` (a flat AND-list). Full guard in media-info-header.ts.
    action: { kind: 'action', actionId: 'media.edit-subtitles' },
  },
  {
    id: 'core.refresh_metadata',
    slot: 'media.actions',
    weight: 1000,
    labelKey: 'media_detail.refresh_metadata',
    icon: 'rotate-ccw',
    when: ['isAdmin'],
    action: { kind: 'action', actionId: 'media.refresh-metadata' },
  },
  {
    id: 'core.analyze',
    slot: 'media.actions',
    weight: 1100,
    labelKey: 'media_detail.analyze',
    icon: 'scan-line',
    when: ['isAdmin'],
    action: { kind: 'action', actionId: 'media.analyze' },
  },
  {
    id: 'core.toggle_monitored',
    slot: 'media.actions',
    weight: 1200,
    labelKey: 'media_detail.monitor',
    icon: 'eye',
    when: ['isAdmin'],
    action: { kind: 'action', actionId: 'media.toggle-monitored' },
  },
  {
    id: 'core.delete',
    slot: 'media.actions',
    weight: 1300,
    labelKey: 'media_detail.delete_from_library',
    icon: 'trash-2',
    tone: 'danger',
    confirmKey: 'media_detail.confirm_delete',
    when: ['hasPermission:media.delete'],
    action: { kind: 'action', actionId: 'media.delete' },
  },
  {
    id: 'core.request_deletion',
    slot: 'media.actions',
    weight: 1400,
    labelKey: 'media_detail.request_deletion',
    icon: 'trash-2',
    tone: 'danger',
    confirmKey: 'media_detail.request_deletion_confirm',
    // The pre-refactor gate is the single `canRequestDeletion` input, already
    // `requests.create && !media.delete && !<a deletion request is already
    // pending>` — pending is per-title async state, not a permission, so it
    // can't be a `when` predicate. Full guard in media-info-header.ts.
    action: { kind: 'action', actionId: 'media.request-deletion' },
  },
];
