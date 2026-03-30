export declare class ImportFileEntry {
    filePath: string;
    mediaId: number;
    episodeId?: number;
    quality: string;
}
export declare class ConfirmDiskImportDto {
    imports: ImportFileEntry[];
}
