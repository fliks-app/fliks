import { CreateLanguageProfileDto } from './dto/create-language-profile.dto';

export const DEFAULT_LANGUAGE_PROFILE_NAME = 'Toutes les langues (défaut)';

/**
 * Default profile: no audio restriction, no forced subtitles. Exists so
 * every media has *some* language profile assigned (mirror of the
 * default quality profile). Runtime resolution never falls back to this —
 * it is purely a seed.
 */
export function buildDefaultLanguageProfileDto(): CreateLanguageProfileDto {
  return {
    name: DEFAULT_LANGUAGE_PROFILE_NAME,
    audioLanguages: [],
    subtitleLanguages: [],
  };
}
