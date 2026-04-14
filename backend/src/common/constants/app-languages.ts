export interface AppLanguageDefinition {
  id: number;
  name: string;
  /** ISO 639-1 (2-letter) code. */
  isoCode: string;
  /** ISO 639-2/B and 639-2/T codes that map to this language. */
  iso639_2?: string[];
}

export const APP_LANGUAGES: AppLanguageDefinition[] = [
  { id: 1, name: 'English', isoCode: 'en', iso639_2: ['eng'] },
  { id: 2, name: 'French', isoCode: 'fr', iso639_2: ['fre', 'fra'] },
  { id: 3, name: 'German', isoCode: 'de', iso639_2: ['ger', 'deu'] },
  { id: 4, name: 'Spanish', isoCode: 'es', iso639_2: ['spa'] },
  { id: 5, name: 'Italian', isoCode: 'it', iso639_2: ['ita'] },
  { id: 6, name: 'Portuguese', isoCode: 'pt', iso639_2: ['por'] },
  { id: 7, name: 'Japanese', isoCode: 'ja', iso639_2: ['jpn'] },
  { id: 8, name: 'Korean', isoCode: 'ko', iso639_2: ['kor'] },
  { id: 9, name: 'Chinese', isoCode: 'zh', iso639_2: ['zho', 'chi'] },
  { id: 10, name: 'Russian', isoCode: 'ru', iso639_2: ['rus'] },
  { id: 11, name: 'Arabic', isoCode: 'ar', iso639_2: ['ara'] },
  { id: 12, name: 'Dutch', isoCode: 'nl', iso639_2: ['nld', 'dut'] },
  { id: 13, name: 'Polish', isoCode: 'pl', iso639_2: ['pol'] },
  { id: 14, name: 'Turkish', isoCode: 'tr', iso639_2: ['tur'] },
  { id: 15, name: 'Swedish', isoCode: 'sv', iso639_2: ['swe'] },
  { id: 16, name: 'Danish', isoCode: 'da', iso639_2: ['dan'] },
  { id: 17, name: 'Norwegian', isoCode: 'no', iso639_2: ['nor'] },
  { id: 18, name: 'Finnish', isoCode: 'fi', iso639_2: ['fin'] },
  { id: 19, name: 'Hindi', isoCode: 'hi', iso639_2: ['hin'] },
  { id: 20, name: 'Czech', isoCode: 'cs', iso639_2: ['ces', 'cze'] },
  { id: 21, name: 'Romanian', isoCode: 'ro', iso639_2: ['ron', 'rum'] },
  { id: 22, name: 'Hungarian', isoCode: 'hu', iso639_2: ['hun'] },
  { id: 23, name: 'Thai', isoCode: 'th', iso639_2: ['tha'] },
  { id: 24, name: 'Vietnamese', isoCode: 'vi', iso639_2: ['vie'] },
  { id: 25, name: 'Hebrew', isoCode: 'he', iso639_2: ['heb'] },
  { id: 26, name: 'Greek', isoCode: 'el', iso639_2: ['ell', 'gre'] },
  { id: 27, name: 'Ukrainian', isoCode: 'uk', iso639_2: ['ukr'] },
  { id: 28, name: 'Bulgarian', isoCode: 'bg', iso639_2: ['bul'] },
  { id: 29, name: 'Croatian', isoCode: 'hr', iso639_2: ['hrv'] },
  { id: 30, name: 'Serbian', isoCode: 'sr', iso639_2: ['srp'] },
  { id: 31, name: 'Slovenian', isoCode: 'sl', iso639_2: ['slv'] },
  { id: 32, name: 'Slovak', isoCode: 'sk', iso639_2: ['slk', 'slo'] },
  { id: 33, name: 'Catalan', isoCode: 'ca', iso639_2: ['cat'] },
  { id: 34, name: 'Basque', isoCode: 'eu', iso639_2: ['eus', 'baq'] },
  { id: 35, name: 'Galician', isoCode: 'gl', iso639_2: ['glg'] },
  { id: 36, name: 'Indonesian', isoCode: 'id', iso639_2: ['ind'] },
  { id: 37, name: 'Malay', isoCode: 'ms', iso639_2: ['msa', 'may'] },
  { id: 99, name: 'Unknown', isoCode: 'xx' },
];

/** ISO 639-2/B+T → ISO 639-1 lookup (built from APP_LANGUAGES). */
export const ISO_639_2_TO_1: Record<string, string> = Object.fromEntries(
  APP_LANGUAGES.flatMap((l) =>
    (l.iso639_2 ?? []).map((code) => [code, l.isoCode]),
  ),
);

const byId = new Map(APP_LANGUAGES.map((l) => [l.id, l]));

export function getAppLanguageById(
  id: number,
): AppLanguageDefinition | undefined {
  return byId.get(id);
}

export const UNKNOWN_LANGUAGE = APP_LANGUAGES.find((l) => l.id === 99)!;
export const ENGLISH_LANGUAGE = APP_LANGUAGES.find((l) => l.id === 1)!;
