import { Injectable, computed, inject } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { DeviceService } from '../services/device.service';
import { TvService } from '../services/tv.service';
import { CORE_NAV_CONTRIBUTIONS, LIBRARIES_BLOCK_WEIGHT } from './core-contributions';
import { PluginUiRegistryService } from './plugin-ui-registry.service';
import { evaluateWhen, type WhenContext } from './when-evaluator';
import type { SlotId, UiContribution } from '@fliks/plugin-contract/ui';

/** A `nav.main` / `nav.acquisition` contribution resolved to something a
 *  template can render directly, with visibility and action already decided. */
export interface ResolvedNavItem {
  id: string;
  labelKey: string;
  /** Compact-surface label for the phone dock; absent means the dock uses `labelKey`. */
  shortLabelKey?: string;
  icon: string;
  route: string;
  exact: boolean;
  weight: number;
  badgeKey?: string;
  badgeClass: string;
}

/** Items pinned to the native-phone dock's limited primary row — excluded
 *  from the overflow "more" sheet so they aren't shown twice. */
export const DOCK_PINNED_IDS: readonly string[] = ['core.home', 'core.downloads', 'core.requests'];
/** Never shown on the native-phone dock or its sheet: Search is its own FAB,
 *  My profile is reachable from the always-visible user menu instead. */
export const MOBILE_HIDDEN_IDS: readonly string[] = ['core.search', 'core.my_profile'];

function sortByWeightThenId(list: readonly UiContribution[]): UiContribution[] {
  return [...list].sort((a, b) => a.weight - b.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Resolves `nav.main` / `nav.acquisition` into renderable items: core's
 * declarative list merged with the registry's plugin contributions, sorted
 * by weight then id, `when`-filtered, and with the action resolved to a
 * route. Every surface (sidebar, dock, more-sheet) reads this — an item
 * cannot appear in one and be missing from another.
 */
@Injectable({ providedIn: 'root' })
export class NavContributionsService {
  private readonly registry = inject(PluginUiRegistryService);
  private readonly auth = inject(AuthService);
  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);

  readonly mainItems = computed(() => this.resolve('nav.main'));
  readonly acquisitionItems = computed(() => this.resolve('nav.acquisition'));

  /** `nav.main` items anchored before the library block (weight < 1000). */
  readonly mainItemsBeforeLibraries = computed(() =>
    this.mainItems().filter((i) => i.weight < LIBRARIES_BLOCK_WEIGHT),
  );
  /** `nav.main` items anchored after the library block (weight >= 1000). */
  readonly mainItemsAfterLibraries = computed(() =>
    this.mainItems().filter((i) => i.weight >= LIBRARIES_BLOCK_WEIGHT),
  );

  private resolve(slot: SlotId): ResolvedNavItem[] {
    const core = CORE_NAV_CONTRIBUTIONS.filter((c) => c.slot === slot);
    const merged = sortByWeightThenId([...core, ...this.registry.contributionsFor(slot)]);
    const ctx: WhenContext = {
      isAdmin: !!this.auth.user()?.isAdmin,
      hasPermission: (p) => this.auth.hasPermission(p),
      isTv: this.tv.isTv(),
      isTouch: this.device.isTouch(),
    };
    const items: ResolvedNavItem[] = [];
    for (const c of merged) {
      if (!evaluateWhen(c.when, ctx)) continue;
      const route = this.resolveRoute(c);
      if (route === null) continue;
      items.push({
        id: c.id,
        labelKey: c.labelKey,
        shortLabelKey: c.shortLabelKey,
        icon: c.icon ?? 'circle',
        route,
        exact: route === '/',
        weight: c.weight,
        badgeKey: c.badge,
        badgeClass: c.tone === 'danger' ? 'badge-warning' : 'badge-primary',
      });
    }
    return items;
  }

  /** Resolves a contribution's action to a route, or `null` to fail closed
   *  (an unknown `action.kind`, or a core action id this client can't serve). */
  private resolveRoute(c: UiContribution): string | null {
    if (c.action.kind === 'route') return c.action.path;
    if (c.action.kind === 'action') {
      if (c.action.actionId === 'nav.my-profile') {
        const id = this.auth.user()?.id;
        return id != null ? `/profile/${id}` : null;
      }
      return null;
    }
    return null;
  }
}
