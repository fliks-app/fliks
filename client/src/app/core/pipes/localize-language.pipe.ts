import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { localizeLanguage } from '../utils/language.utils';

/**
 * Resolve a language code (2- or 3-letter, any case) to its translated
 * display name via the `language.*` i18n keys. Mirrors what the player
 * shows for audio/subtitle tracks so the rest of the UI stays consistent.
 *
 * Impure because the translation table is loaded asynchronously and may
 * change at runtime when the user switches locale.
 */
@Pipe({ name: 'localizeLanguage', pure: false })
export class LocalizeLanguagePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(code: string | null | undefined): string {
    return localizeLanguage(code, this.translate);
  }
}
