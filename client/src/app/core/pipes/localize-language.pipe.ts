import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { localizeLanguage } from '../utils/language.utils';

/** Resolves a language code (2- or 3-letter, any case) to its translated name via `language.*`, as the player shows tracks.
 *  Impure because translations load asynchronously and change with the locale. */
@Pipe({ name: 'localizeLanguage', pure: false })
export class LocalizeLanguagePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(code: string | null | undefined): string {
    return localizeLanguage(code, this.translate);
  }
}
