import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { StalledCleanupProfileKey } from '../../../../core/services/api/libraries-api.service';
import { METADATA_PROVIDER_OPTIONS_LIBRARY } from '../../../../core/constants/metadata-providers';
import {
  METADATA_LANGUAGE_OPTIONS,
  METADATA_REGION_OPTIONS,
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

  readonly iconOptions = [
    { value: null, label: 'Par défaut (bibliothèque)' },
    { value: 'film', label: 'Film' },
    { value: 'tv', label: 'TV' },
    { value: 'popcorn', label: 'Popcorn' },
    { value: 'clapperboard', label: 'Clap' },
    { value: 'book', label: 'Livre' },
    { value: 'gamepad-2', label: 'Jeux' },
    { value: 'music', label: 'Musique' },
    { value: 'heart', label: 'Cœur' },
    { value: 'star', label: 'Étoile' },
    { value: 'globe', label: 'Globe' },
    { value: 'monitor', label: 'Écran' },
    { value: 'users', label: 'Utilisateurs' },
    { value: 'folder', label: 'Dossier' },
    { value: 'swords', label: 'Épées' },
  ];

  readonly colorOptions = [
    { value: null, label: 'Par défaut (primary)' },
    { value: 'primary', label: 'Primary' },
    { value: 'secondary', label: 'Secondary' },
    { value: 'accent', label: 'Accent' },
    { value: 'info', label: 'Info' },
    { value: 'success', label: 'Success' },
    { value: 'warning', label: 'Warning' },
    { value: 'error', label: 'Error' },
  ];

  readonly providerOptions = METADATA_PROVIDER_OPTIONS_LIBRARY;
  readonly metadataLanguageOptions = METADATA_LANGUAGE_OPTIONS;
  readonly metadataRegionOptions = METADATA_REGION_OPTIONS;
  readonly cleanupOptions: { value: StalledCleanupProfileKey | null; labelKey: string }[] = [
    { value: null, labelKey: 'settings.cleanup_profiles.none' },
    { value: 'fast', labelKey: 'settings.cleanup_profiles.profile_fast' },
    { value: 'medium', labelKey: 'settings.cleanup_profiles.profile_medium' },
    { value: 'slow', labelKey: 'settings.cleanup_profiles.profile_slow' },
  ];

  save() {
    void this.state.save();
  }
}
