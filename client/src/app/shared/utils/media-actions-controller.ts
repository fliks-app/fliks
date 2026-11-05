import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { UiContribution } from '@fliks/plugin-ui';
import {
  WantsStore,
  acquisitionWhen,
  aimedWants,
  type AcquisitionBase,
  type AcquisitionContext,
} from '../../core/acquisition/acquisition';
import { resolveMediaAction, type MediaActionHandlers } from '../../core/plugin-ui/media-action-registry';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import { resolveMenuContributions, type ResolvedMenuRow } from '../../core/plugin-ui/resolve-menu-contributions';
import type { WhenContext } from '../../core/plugin-ui/when-evaluator';
import { ReleaseGrabController } from '../../features/media-detail/release-grab-controller';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';

/** The acquisition actionIds of a level: `media.*` for the work, `group.*`, `item.*` below it. */
const ID_PREFIX = { work: 'media', group: 'group', item: 'item' } as const;

/** Where each level reads its plugin contributions. */
const SLOTS = {
  work: ['media.actions', 'card.actions'],
  group: ['media.group.actions'],
  item: ['media.item.actions', 'card.actions'],
} as const;

export interface MediaActionsConfig {
  base: () => AcquisitionBase;
  /** What only the page knows: its files, its monitoring, whether the title is identified, the viewer's admin right. */
  facts: () => Pick<AcquisitionContext, 'hasFiles' | 'identified'> & { isAdmin: boolean; isMonitored?: boolean };
  /** Core entries merged with the plugin ones; a group menu has none. */
  core?: readonly UiContribution[];
  handlers?: () => MediaActionHandlers;
  guards?: Record<string, () => boolean>;
}

/** The menu of one title, group or item, whatever its kind: the `when` context, the acquisition handlers and the merge of core and plugin rows,
 *  shared by every detail header so none rebuilds them. */
export class MediaActionsController {
  private readonly pluginUi = inject(PluginUiRegistryService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly device = inject(DeviceService);
  private readonly tv = inject(TvService);
  private readonly wantsStore = inject(WantsStore);
  private readonly grabs = inject(ReleaseGrabController);

  constructor(private readonly cfg: MediaActionsConfig) {}

  readonly acquisition = computed<AcquisitionContext>(() => {
    const b = this.cfg.base();
    const f = this.cfg.facts();
    return { level: b.level, wants: this.wantsStore.wantsOf(b.mediaId), hasFiles: f.hasFiles, identified: f.identified };
  });

  readonly whenContext = computed<WhenContext>(() => {
    const f = this.cfg.facts();
    return {
      isAdmin: f.isAdmin,
      hasPermission: (p) => this.auth.hasPermission(p),
      isMonitored: f.isMonitored,
      isTv: this.tv.isTv(),
      isTouch: this.device.isTouch(),
      surface: 'detail',
      ...acquisitionWhen(this.acquisition(), this.cfg.base().kind),
    };
  });

  /** The plugin has something to offer at this level: gates a button that would open an empty menu. */
  readonly available = computed(
    () => SLOTS[this.cfg.base().level].some((slot) => this.pluginUi.contributionsFor(slot).length > 0) && aimedWants(this.acquisition()).length > 0,
  );

  readonly rows = computed<ResolvedMenuRow[]>(() => {
    const base = this.cfg.base();
    return resolveMenuContributions({
      contributions: [...(this.cfg.core ?? []), ...SLOTS[base.level].flatMap((slot) => this.pluginUi.contributionsFor(slot))],
      ctx: this.whenContext(),
      guards: this.cfg.guards,
      resolveAction: (id) => this.resolve(id),
      navigate: (path) => void this.router.navigate([path]),
    });
  });

  private isSearch(id: string | undefined): boolean {
    return id === `${ID_PREFIX[this.cfg.base().level]}.search-releases`;
  }

  private isGrabBest(id: string | undefined): boolean {
    return id === `${ID_PREFIX[this.cfg.base().level]}.grab-best`;
  }

  private resolve(id: string): (() => void) | null {
    if (this.isSearch(id)) return () => void this.grabs.search(this.cfg.base(), aimedWants(this.acquisition()));
    if (this.isGrabBest(id)) return () => void this.grabs.grabBest(this.cfg.base(), aimedWants(this.acquisition()));
    return resolveMediaAction(id, this.cfg.handlers?.() ?? {});
  }

  /** Mid-request spinner of an acquisition row. */
  isBusy(actionId: string | undefined): boolean {
    const base = this.cfg.base();
    if (this.isGrabBest(actionId)) return this.grabs.isBestBusy(base);
    return this.isSearch(actionId) && this.grabs.isSearching(base);
  }

  /** A grab-best locks while any release is being grabbed, here or from the modal. */
  isDisabled(actionId: string | undefined): boolean {
    return this.isGrabBest(actionId) && (this.grabs.isBestBusy(this.cfg.base()) || this.grabs.grabBusy() !== null);
  }
}
