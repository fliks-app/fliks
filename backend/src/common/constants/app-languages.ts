export interface AppLanguageDefinition {
  id: number;
  name: string;
  isoCode: string;
}

export const APP_LANGUAGES: AppLanguageDefinition[] = [
  { id: 1, name: 'English', isoCode: 'en' },
  { id: 2, name: 'French', isoCode: 'fr' },
  { id: 3, name: 'German', isoCode: 'de' },
  { id: 4, name: 'Spanish', isoCode: 'es' },
  { id: 5, name: 'Italian', isoCode: 'it' },
  { id: 6, name: 'Portuguese', isoCode: 'pt' },
  { id: 7, name: 'Japanese', isoCode: 'ja' },
  { id: 8, name: 'Korean', isoCode: 'ko' },
  { id: 9, name: 'Chinese', isoCode: 'zh' },
  { id: 10, name: 'Russian', isoCode: 'ru' },
  { id: 11, name: 'Arabic', isoCode: 'ar' },
  { id: 12, name: 'Dutch', isoCode: 'nl' },
  { id: 13, name: 'Polish', isoCode: 'pl' },
  { id: 14, name: 'Turkish', isoCode: 'tr' },
  { id: 15, name: 'Swedish', isoCode: 'sv' },
  { id: 16, name: 'Danish', isoCode: 'da' },
  { id: 17, name: 'Norwegian', isoCode: 'no' },
  { id: 18, name: 'Finnish', isoCode: 'fi' },
  { id: 99, name: 'Unknown', isoCode: 'xx' },
];

const byId = new Map(APP_LANGUAGES.map((l) => [l.id, l]));

export function getAppLanguageById(
  id: number,
): AppLanguageDefinition | undefined {
  return byId.get(id);
}

export const UNKNOWN_LANGUAGE = APP_LANGUAGES.find((l) => l.id === 99)!;
export const ENGLISH_LANGUAGE = APP_LANGUAGES.find((l) => l.id === 1)!;
