import { Component, computed, inject, signal } from '@angular/core';
import { TvSelectDirective } from '../../../../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LIBRARY_COLOR_OPTIONS,
  LIBRARY_ICON_OPTIONS,
  libraryColorVar,
} from '../../../../../core/constants/library-appearance';
import { DEFAULT_LOCALE } from '../../../../../core/constants/app-locale';
import { MEDIA_KINDS, KIND_REGISTRY } from '../../../../../core/media-kinds';
import type { MediaType } from '../../../../../core/enums/media-type.enum';
import {
  MetadataService,
  ServingProvider,
  readOrder,
  withStoredProvider,
} from '../../../../../core/services/api/metadata.service';
import {
  METADATA_LANGUAGE_OPTIONS,
  metadataRegionOptions,
} from '../../../../../core/constants/metadata-locale';
import { LucideIconComponent } from '../../../../../shared/components/lucide-icon';
import {
  MetadataProfile,
  PRIMARY_TYPES,
  RELEASE_STATUSES,
  SECONDARY_TYPES,
} from '../../../../../core/services/api/libraries-api.service';
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
  private readonly metadata = inject(MetadataService);

  readonly iconOptions = LIBRARY_ICON_OPTIONS;
  readonly colorOptions = LIBRARY_COLOR_OPTIONS;

  readonly kinds = MEDIA_KINDS;
  readonly registry = KIND_REGISTRY;

  readonly profileGroups: { list: keyof MetadataProfile; titleKey: string; values: readonly string[] }[] = [
    { list: 'primaryTypes', titleKey: 'settings.libraries.profile_primary', values: PRIMARY_TYPES },
    { list: 'secondaryTypes', titleKey: 'settings.libraries.profile_secondary', values: SECONDARY_TYPES },
    { list: 'statuses', titleKey: 'settings.libraries.profile_statuses', values: RELEASE_STATUSES },
  ];

  private readonly serving = signal<Record<MediaType, ServingProvider[]> | null>(null);

  /** The providers serving at least one selected kind, each once. */
  readonly providerOptions = computed(() => {
    const serving = this.serving();
    const all = this.state.mediaTypes().flatMap((k) => serving?.[k] ?? []);
    const unique = all.filter((p, i) => all.findIndex((o) => o.provider === p.provider) === i);
    return withStoredProvider(unique, this.state.formProvider());
  });

  /** Per selected kind, the providers in the order a refresh reads them. */
  readonly readOrders = computed(() => {
    const serving = this.serving();
    if (!serving) return [];
    return this.state.mediaTypes().map((kind) => ({
      kind,
      labels: readOrder(serving[kind] ?? [], this.state.formProvider()).map((p) => p.label),
    }));
  });
  readonly metadataLanguageOptions = METADATA_LANGUAGE_OPTIONS;
  readonly metadataRegionOptions = metadataRegionOptions(this.translate.currentLang() ?? DEFAULT_LOCALE);

  readonly colorVar = libraryColorVar;

  constructor() {
    this.metadata
      .providersByKind()
      .then((s) => this.serving.set(s))
      .catch(() => undefined);
  }
}
