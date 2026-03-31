export declare class QualityDefinitionItemDto {
    qualityId: number;
    title?: string;
    minSize: number;
    preferredSize: number;
    maxSize: number;
}
export declare class UpdateQualityDefinitionsDto {
    items: QualityDefinitionItemDto[];
}
