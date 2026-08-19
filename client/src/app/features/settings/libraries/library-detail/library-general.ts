import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LIBRARY_COLOR_OPTIONS,
  LIBRARY_ICON_OPTIONS,
} from '../../../../core/constants/library-appearance';
import { METADATA_PROVIDER_OPTIONS_LIBRARY } from '../../../../core/constants/metadata-providers';
import {
  METADATA_LANGUAGE_OPTIONS,
  metadataRegionOptions,
} from '../../../../core/constants/metadata-locale';
import { LibraryDetailState } from './library-detail.state';

@Component({
  selector: 'app-library-general',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library-general.html',
})
export class LibraryGeneralComponent {
  readonly state = inject(LibraryDetailState);
  private readonly translate = inject(TranslateService);

  readonly iconOptions = LIBRARY_ICON_OPTIONS;
  readonly colorOptions = LIBRARY_COLOR_OPTIONS;

  readonly providerOptions = METADATA_PROVIDER_OPTIONS_LIBRARY;
  readonly metadataLanguageOptions = METADATA_LANGUAGE_OPTIONS;
  readonly metadataRegionOptions = metadataRegionOptions(this.translate.currentLang);

  save() {
    void this.state.save();
  }
}
