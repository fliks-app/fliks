export declare class CreateIndexerDto {
    name: string;
    implementation: string;
    settings?: Record<string, unknown>;
    enableRss?: boolean;
    enableSearch?: boolean;
    priority?: number;
    enabled?: boolean;
    tagIds?: number[];
}
