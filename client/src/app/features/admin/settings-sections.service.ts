import { Injectable, computed, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';
import { CORE_SETTINGS_SECTIONS } from '../../core/plugin-ui/core-contributions';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import { evaluateWhen, type WhenContext } from '../../core/plugin-ui/when-evaluator';
import type { UiContribution } from '@fliks/plugin-contract/ui';

export interface ResolvedSettingsItem {
  id: string;
  labelKey: string;
  icon?: string;
  route: string;
}

export interface ResolvedSettingsSection {
  id: string;
  /** An i18n key for a core section; a plugin section's manifest name (or
   *  its id as a last resort) — always piped through `translate`, which
   *  falls back to the literal string when no such key exists. */
  label: string;
  items: ResolvedSettingsItem[];
}

function sortByWeightThenId(list: readonly UiContribution[]): UiContribution[] {
  return [...list].sort((a, b) => a.weight - b.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Resolves `settings.page` into the admin sidebar's section list. Unlike
 * `nav.main`/`nav.acquisition`, a plugin never joins a core section: every
 * plugin's pages form one section of their own, labelled by the plugin's
 * manifest name and ordered after every core section, by plugin id — never
 * by install order. A section with no visible item cannot appear at all,
 * core or plugin, so an install/uninstall or a `when` change can never leave
 * an orphaned header.
 */
@Injectable({ providedIn: 'root' })
export class SettingsSectionsService {
  private readonly registry = inject(PluginUiRegistryService);
  private readonly auth = inject(AuthService);
  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  private readonly router = inject(Router);

  /** Path only: a query string or a fragment is never part of what a nav entry addresses. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.split(/[?#]/)[0] ?? ''),
    ),
    { initialValue: this.router.url.split(/[?#]/)[0] ?? '' },
  );

  readonly sections = computed<ResolvedSettingsSection[]>(() => {
    const ctx: WhenContext = {
      isAdmin: !!this.auth.user()?.isAdmin,
      hasPermission: (p) => this.auth.hasPermission(p),
      isTv: this.tv.isTv(),
      isTouch: this.device.isTouch(),
    };

    const core = CORE_SETTINGS_SECTIONS.map((s) => ({
      id: `core:${s.labelKey}`,
      label: s.labelKey,
      items: this.resolveItems(s.items, ctx),
    }));

    const plugins = [...this.registry.pluginEntries()]
      .sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0))
      .map((e) => ({
        id: `plugin:${e.pluginId}`,
        label: e.name ?? e.pluginId,
        items: this.resolveItems(
          sortByWeightThenId((e.contributions ?? []).filter((c) => c.slot === 'settings.page')),
          ctx,
        ),
      }));

    return [...core, ...plugins].filter((s) => s.items.length > 0);
  });

  /**
   * The entry the current URL belongs to: the longest route that prefixes it, so a deeper entry
   * wins over the shallower one it happens to sit under. `/admin/settings/plugins/<id>/<view>`
   * therefore lights that plugin's own entry and not the Plugins page, while a library detail
   * still lights Libraries, which has no deeper entry to lose to.
   */
  readonly activeItemId = computed<string | null>(() => {
    const url = this.url();
    let best: ResolvedSettingsItem | null = null;
    for (const section of this.sections()) {
      for (const item of section.items) {
        if (url !== item.route && !url.startsWith(`${item.route}/`)) continue;
        if (!best || item.route.length > best.route.length) best = item;
      }
    }
    return best?.id ?? null;
  });

  /** `when`-filters and resolves the action to a route; drops a contribution
   *  this client can't render rather than showing a broken row. */
  private resolveItems(items: readonly UiContribution[], ctx: WhenContext): ResolvedSettingsItem[] {
    const out: ResolvedSettingsItem[] = [];
    for (const c of items) {
      if (!evaluateWhen(c.when, ctx)) continue;
      if (c.action.kind !== 'route') continue;
      out.push({ id: c.id, labelKey: c.labelKey, icon: c.icon, route: c.action.path });
    }
    return out;
  }
}
