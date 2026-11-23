import { Injectable, effect, inject, untracked } from '@angular/core';
import { TranslateService, TranslateStore, mergeDeep, type TranslationObject } from '@ngx-translate/core';
import { PluginUiRegistryService } from './plugin-ui-registry.service';

/** Merges each plugin's flat `i18n[lang]` map into ngx-translate; core wins collisions via `mergeDeep(plugin, core)`.
 * Missing locales use the app's existing `fallbackLang`. */
@Injectable({ providedIn: 'root' })
export class PluginI18nService {
  private readonly translate = inject(TranslateService);
  private readonly store = inject(TranslateStore);
  private readonly registry = inject(PluginUiRegistryService);

  constructor() {
    // Core translations load asynchronously and may still be in flight at init(); catch up on every (re)load and language switch.
    this.translate.onLangChange.subscribe(({ lang }) => this.mergeIntoLang(lang));
    this.translate.onFallbackLangChange.subscribe(({ lang }) => this.mergeIntoLang(lang));

    // A plugin install/enable/disable reloads the registry; the entries read is the effect's dependency, since `getLangs()` can be empty.
    effect(() => {
      this.registry.pluginEntries();
      // Untracked: `setTranslations` writes the language signal `getLangs()` reads, which would re-enter this effect forever.
      untracked(() => {
        for (const lang of this.translate.getLangs()) this.mergeIntoLang(lang);
      });
    });
  }

  /** Called once from the app initializer after the registry loads; never awaits the translation call, so boot isn't blocked. */
  init(): void {
    for (const lang of this.translate.getLangs()) this.mergeIntoLang(lang);
  }

  mergeIntoLang(lang: string): void {
    const flat = this.registry.i18nFor(lang);
    if (!flat) return;
    const core = (this.store.getTranslations(lang) ?? {}) as Dict;
    const missing: Dict = {};
    let any = false;
    for (const [key, value] of Object.entries(flat)) {
      if (!isFree(core, key)) continue;
      setPath(missing, key, value);
      any = true;
    }
    // Nothing left to add: skip the store write, whose change event re-runs every translate pipe.
    if (any) this.store.setTranslations(lang, mergeDeep(missing, core) as TranslationObject, false);
  }
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when core holds nothing at `key`, nor a leaf on its path (core wins that collision). */
function isFree(core: Dict, key: string): boolean {
  const parts = key.split('.');
  let node = core;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === undefined) return true;
    if (!isDict(next)) return false;
    node = next;
  }
  return node[parts[parts.length - 1]] === undefined;
}

function setPath(target: Dict, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!isDict(node[part])) node[part] = {};
    node = node[part] as Dict;
  }
  node[parts[parts.length - 1]] = value;
}
