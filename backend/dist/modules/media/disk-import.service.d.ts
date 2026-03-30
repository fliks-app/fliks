import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { MediaFile } from './entities/media-file.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { ImportFileEntry } from './dto/confirm-disk-import.dto';
export interface ScanCandidate {
    filePath: string;
    filename: string;
    size: number;
    qualityName: string;
    qualityId: number;
    seasonNumber: number | null;
    episodeNumber: number | null;
    mediaId: number | null;
    mediaTitle: string | null;
    mediaYear: number | null;
    mediaType: string | null;
    episodeId: number | null;
    episodeTitle: string | null;
}
export declare class DiskImportService {
    private readonly mediaRepo;
    private readonly fileRepo;
    private readonly seasonRepo;
    private readonly episodeRepo;
    constructor(mediaRepo: Repository<Media>, fileRepo: Repository<MediaFile>, seasonRepo: Repository<Season>, episodeRepo: Repository<Episode>);
    scanFolder(folderPath: string): Promise<ScanCandidate[]>;
    confirmImport(imports: ImportFileEntry[]): Promise<{
        imported: number;
        errors: string[];
    }>;
    private collectVideoFiles;
    private buildCandidate;
    private extractTitle;
    private matchMedia;
    private parseEpisodeNumbers;
}
