import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
export interface ApiImportResult {
    imported: number;
    errors: string[];
    rootFoldersCreated: string[];
    qualityProfilesCreated: string[];
}
export declare class ImportSonarrService {
    private readonly mediaRepo;
    private readonly rootFolderRepo;
    private readonly qpRepo;
    private readonly config;
    private readonly log;
    constructor(mediaRepo: Repository<Media>, rootFolderRepo: Repository<RootFolder>, qpRepo: Repository<QualityProfile>, config: ConfigService);
    importFromApi(url: string, apiKey: string): Promise<ApiImportResult>;
    private importQualityProfiles;
    private mapRemoteItems;
    private findLocalQuality;
    private resolveCutoff;
    private reconcileRootFolders;
    importFromDump(buffer: Buffer): Promise<{
        imported: number;
        skipped: number;
        errors: string[];
    }>;
}
