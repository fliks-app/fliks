import type { MetadataProvider } from '../services/api/media.service';

export interface MetadataProviderOption {
  value: MetadataProvider | null;
  label?: string;
  labelKey?: string;
}

/** Inherit-label = "Auto" in the library picker (default behavior of the whole library). */
export const METADATA_PROVIDER_OPTIONS_LIBRARY: readonly MetadataProviderOption[] = [
  { value: null, labelKey: 'settings.libraries.provider_auto' },
  { value: 'tmdb', label: 'TMDB' },
  { value: 'tvdb', label: 'TVDB' },
] as const;

/** Inherit-label = "Inherit from library" on per-media / per-season overrides. */
export const METADATA_PROVIDER_OPTIONS_OVERRIDE: readonly MetadataProviderOption[] = [
  { value: null, labelKey: 'media_detail.provider_inherit' },
  { value: 'tmdb', label: 'TMDB' },
  { value: 'tvdb', label: 'TVDB' },
] as const;
