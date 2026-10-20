import { Injectable, effect, inject, untracked } from '@angular/core';
import { TranslateService, TranslateStore, insertValue, mergeDeep, type TranslationObject } from '@ngx-translate/core';
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
    let pluginNested: TranslationObject = {};
    for (const [key, value] of Object.entries(flat)) {
      pluginNested = insertValue(pluginNested, key, value) as TranslationObject;
    }
    const core = this.store.getTranslations(lang) as TranslationObject | undefined;
    this.store.setTranslations(lang, mergeDeep(pluginNested, core ?? {}), false);
  }
}
