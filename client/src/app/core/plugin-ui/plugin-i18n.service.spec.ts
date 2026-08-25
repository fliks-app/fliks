import { ApplicationRef, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TranslateLoader,
  TranslateService,
  provideTranslateService,
  type TranslationObject,
} from '@ngx-translate/core';
import { firstValueFrom, of } from 'rxjs';
import { PluginI18nService } from './plugin-i18n.service';
import { PluginUiRegistryService } from './plugin-ui-registry.service';

describe('PluginI18nService', () => {
  const loaderData: Record<string, TranslationObject> = {};

  beforeEach(() => {
    for (const key of Object.keys(loaderData)) delete loaderData[key];
  });

  function setup(pluginI18n: Record<string, Record<string, string>>) {
    // Signal-backed like the real registry, so `install()` reproduces what a
    // runtime `registry.load()` does to every consumer that reads it.
    const dicts = signal(pluginI18n);
    const fakeRegistry = {
      i18nFor: (lang: string) => dicts()[lang],
      pluginEntries: () => Object.keys(dicts()),
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          fallbackLang: 'en',
          loader: {
            provide: TranslateLoader,
            useValue: { getTranslation: (lang: string) => of(loaderData[lang] ?? {}) },
          },
        }),
        { provide: PluginUiRegistryService, useValue: fakeRegistry },
      ],
    });
    return {
      translate: TestBed.inject(TranslateService),
      i18n: TestBed.inject(PluginI18nService),
      install: (next: Record<string, Record<string, string>>) => dicts.set(next),
    };
  }

  it('expands a flat "a.b.c" plugin key into nested translations so labelKey resolves', () => {
    loaderData['en'] = {};
    const { translate, i18n } = setup({ en: { 'fliks.foo.title': 'Foo' } });
    i18n.mergeIntoLang('en');
    expect(translate.instant('fliks.foo.title')).toBe('Foo');
  });

  // The whole safety property: a plugin manifest must never deface a core label.
  it('VERDICT: a plugin can never overwrite an existing core key — core wins', () => {
    loaderData['en'] = { nav: { home: 'Home' } };
    const { translate, i18n } = setup({ en: { 'nav.home': 'HACKED' } });
    i18n.mergeIntoLang('en');
    expect(translate.instant('nav.home')).toBe('Home');
  });

  it('still lets a plugin fill in a key core does not define', () => {
    loaderData['en'] = { nav: { home: 'Home' } };
    const { translate, i18n } = setup({ en: { 'nav.plugin_item': 'Plugin item' } });
    i18n.mergeIntoLang('en');
    expect(translate.instant('nav.home')).toBe('Home');
    expect(translate.instant('nav.plugin_item')).toBe('Plugin item');
  });

  it('does nothing for a locale no plugin ships a dict for', () => {
    loaderData['en'] = { nav: { home: 'Home' } };
    const { translate, i18n } = setup({ fr: { 'nav.home': 'HACKED' } });
    i18n.mergeIntoLang('en');
    expect(translate.instant('nav.home')).toBe('Home');
  });

  it('re-merges on a runtime language switch — the fresh core load never wipes the plugin keys, and core still wins', async () => {
    loaderData['en'] = {};
    loaderData['fr'] = { nav: { home: 'Accueil' } };
    const { translate } = setup({ fr: { 'nav.home': 'HACKED', 'nav.plugin_item': 'Item' } });

    await firstValueFrom(translate.use('fr'));

    expect(translate.instant('nav.home')).toBe('Accueil');
    expect(translate.instant('nav.plugin_item')).toBe('Item');
  });

  // The merge writes through TranslateStore, which fires `onTranslationChange`. Subscribing to that
  // here — rather than to `onLangChange` only — is what would make a language switch re-enter forever.
  it('VERDICT: a language switch never re-enters the merge', async () => {
    loaderData['en'] = { nav: { home: 'Home' } };
    loaderData['fr'] = { nav: { home: 'Accueil' } };
    const { translate, i18n } = setup({ en: { 'p.a': 'A' }, fr: { 'p.a': 'Aa' } });

    let calls = 0;
    let depth = 0;
    let maxDepth = 0;
    const merge = i18n.mergeIntoLang.bind(i18n);
    i18n.mergeIntoLang = (lang: string) => {
      calls++;
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      if (calls > 50) throw new Error(`runaway merge: ${calls} calls`);
      try {
        merge(lang);
      } finally {
        depth--;
      }
    };

    i18n.init();
    await firstValueFrom(translate.use('fr'));

    expect(maxDepth).toBe(1);
    expect(calls).toBeLessThan(10);
    expect(translate.instant('p.a')).toBe('Aa');
  });

  it('init() merges whatever is already loaded without awaiting the network', () => {
    loaderData['en'] = { nav: { home: 'Home' } };
    const { translate, i18n } = setup({ en: { 'nav.plugin_item': 'Item' } });
    i18n.init();
    expect(translate.instant('nav.plugin_item')).toBe('Item');
  });

  it('falls back to the app default fallbackLang for a locale the plugin never ships — no new mechanism', async () => {
    loaderData['en'] = {};
    loaderData['fr'] = {};
    const { translate, i18n } = setup({ en: { 'fliks.foo.title': 'Foo' } });
    i18n.init();

    await firstValueFrom(translate.use('fr'));

    // 'fr' has no plugin dict at all; ngx-translate's own fallbackLang picks
    // up the key from 'en', where the plugin's merge landed at init.
    expect(translate.instant('fliks.foo.title')).toBe('Foo');
  });

  // Installing a plugin reloads the registry mid-session; before this the merge only
  // ran from the app initializer, so its labels stayed raw until a full page reload.
  it('VERDICT: a plugin installed after boot resolves its labels with no page reload', async () => {
    loaderData['en'] = { nav: { home: 'Home' } };
    const { translate, i18n, install } = setup({});
    i18n.init();
    expect(translate.instant('acme.hello')).toBe('acme.hello');

    install({ en: { 'acme.hello': 'Hello' } });
    await TestBed.inject(ApplicationRef).whenStable();

    expect(translate.instant('acme.hello')).toBe('Hello');
    expect(translate.instant('nav.home')).toBe('Home');
  });
});
