import { Injectable, effect, inject } from '@angular/core';
import { TranslateService, TranslateStore, insertValue, mergeDeep, type TranslationObject } from '@ngx-translate/core';
import { PluginUiRegistryService } from './plugin-ui-registry.service';

/**
 * Merges each plugin's `i18n[lang]` (a flat `"a.b.c": "value"` map) into
 * ngx-translate. Core always wins a key collision: the plugin's dict is
 * expanded to a nested object first, then `mergeDeep(plugin, core)` puts
 * core second so its leaves overwrite the plugin's, never the reverse.
 * Missing locales fall back the way the app already does — `fallbackLang`
 * in `provideTranslateService` — nothing extra is needed here for that.
 */
@Injectable({ providedIn: 'root' })
export class PluginI18nService {
  private readonly translate = inject(TranslateService);
  private readonly store = inject(TranslateStore);
  private readonly registry = inject(PluginUiRegistryService);

  constructor() {
    // Core's own translations load asynchronously and may still be in
    // flight when init() runs; catch up whenever a (re)load completes,
    // including a later runtime language switch.
    this.translate.onLangChange.subscribe(({ lang }) => this.mergeIntoLang(lang));
    this.translate.onFallbackLangChange.subscribe(({ lang }) => this.mergeIntoLang(lang));

    // Installing, enabling or disabling a plugin reloads the registry; without this
    // its labels stay unresolved until the next full page load. The entries read is
    // the dependency — `getLangs()` can be empty, so relying on `mergeIntoLang` to
    // register it would leave the effect subscribed to nothing.
    effect(() => {
      this.registry.pluginEntries();
      for (const lang of this.translate.getLangs()) this.mergeIntoLang(lang);
    });
  }

  /** Called once from the app initializer, after the registry has loaded.
   *  Never awaits the translation network call — a plugin label resolves
   *  whenever core's own labels do, never later, never blocking boot. */
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
