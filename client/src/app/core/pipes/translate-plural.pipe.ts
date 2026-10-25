import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

const rules = new Map<string, Intl.PluralRules>();

/** The `<key>_one` / `<key>_other` translation for `count`, chosen by the UI language's plural rules (French 0 is
 *  singular, English 0 plural); `count` is passed as a param. */
export function translatePlural(translate: TranslateService, key: string, count: number, params: object = {}): string {
  const lang = translate.currentLang() || translate.fallbackLang() || 'en';
  let r = rules.get(lang);
  if (!r) rules.set(lang, (r = new Intl.PluralRules(lang)));
  return translate.instant(`${key}_${r.select(count) === 'one' ? 'one' : 'other'}`, { ...params, count });
}

/** Template form of {@link translatePlural}; impure because the table loads asynchronously and changes with locale. */
@Pipe({ name: 'translatePlural', pure: false })
export class TranslatePluralPipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(key: string, count: number, params: object = {}): string {
    return translatePlural(this.translate, key, count, params);
  }
}
