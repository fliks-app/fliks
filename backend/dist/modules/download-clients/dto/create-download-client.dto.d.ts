export declare class CreateDownloadClientDto {
    name: string;
    implementation: string;
    settings?: Record<string, unknown>;
    enabled?: boolean;
    priority?: number;
    tagIds?: number[];
}
