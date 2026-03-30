export interface SuitarrLanguageDefinition {
    id: number;
    name: string;
    isoCode: string;
}
export declare const SUITARR_LANGUAGES: SuitarrLanguageDefinition[];
export declare function getSuitarrLanguageById(id: number): SuitarrLanguageDefinition | undefined;
export declare const UNKNOWN_LANGUAGE: SuitarrLanguageDefinition;
export declare const ENGLISH_LANGUAGE: SuitarrLanguageDefinition;
