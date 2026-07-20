/** Machine-translation engines a translation provider can run on. */
export const TRANSLATION_ENGINES = [
  'gemini',
  'openai',
  'libretranslate',
] as const;

export type TranslationEngine = (typeof TRANSLATION_ENGINES)[number];

/** Model used when a Gemini provider leaves the model unset. */
export const DEFAULT_TRANSLATION_MODEL = 'gemini-2.0-flash';
