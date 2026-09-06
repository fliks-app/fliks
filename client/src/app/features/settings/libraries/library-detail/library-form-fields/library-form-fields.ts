import { Component, inject } from '@angular/core';
import { TvSelectDirective } from '../../../../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LIBRARY_COLOR_OPTIONS,
  LIBRARY_ICON_OPTIONS,
  libraryColorVar,
} from '../../../../../core/constants/library-appearance';
import { DEFAULT_LOCALE } from '../../../../../core/constants/app-locale';
import { METADATA_PROVIDER_OPTIONS_LIBRARY } from '../../../../../core/constants/metadata-providers';
import {
  METADATA_LANGUAGE_OPTIONS,
  metadataRegionOptions,
} from '../../../../../core/constants/metadata-locale';
import { LucideIconComponent } from '../../../../../shared/components/lucide-icon';
import { LibraryDetailState } from '../library-detail.state';

@Component({
  selector: 'app-library-form-fields',
  imports: [TvSelectDirective, FormsModule, TranslatePipe, LucideIconComponent],
  templateUrl: './library-form-fields.html',
  host: { class: 'flex flex-col gap-5' },
})
export class LibraryFormFieldsComponent {
  readonly state = inject(LibraryDetailState);
  private readonly translate = inject(TranslateService);

  readonly iconOptions = LIBRARY_ICON_OPTIONS;
  readonly colorOptions = LIBRARY_COLOR_OPTIONS;

  readonly providerOptions = METADATA_PROVIDER_OPTIONS_LIBRARY;
  readonly metadataLanguageOptions = METADATA_LANGUAGE_OPTIONS;
  readonly metadataRegionOptions = metadataRegionOptions(this.translate.currentLang() ?? DEFAULT_LOCALE);

  readonly colorVar = libraryColorVar;
}
