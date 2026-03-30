export declare class LanguageItemDto {
    languageId: number;
    languageName: string;
    isoCode: string;
    allowed: boolean;
    sortOrder: number;
}
export declare class CreateLanguageProfileDto {
    name: string;
    cutoff: number;
    languages: LanguageItemDto[];
}
