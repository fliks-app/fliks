import { Repository } from 'typeorm';
import { QualityProfile } from './entities/quality-profile.entity';
import { LanguageProfile } from './entities/language-profile.entity';
import { CreateQualityProfileDto } from './dto/create-quality-profile.dto';
import { CreateLanguageProfileDto } from './dto/create-language-profile.dto';
export declare class ProfilesService {
    private readonly qpRepo;
    private readonly lpRepo;
    constructor(qpRepo: Repository<QualityProfile>, lpRepo: Repository<LanguageProfile>);
    ensureDefaultQualityProfiles(): Promise<void>;
    resolveQualityProfileIdForImport(requested?: number): Promise<number | null>;
    createQualityProfile(dto: CreateQualityProfileDto): Promise<QualityProfile>;
    findAllQualityProfiles(): Promise<QualityProfile[]>;
    findOneQualityProfile(id: number): Promise<QualityProfile>;
    updateQualityProfile(id: number, dto: CreateQualityProfileDto): Promise<QualityProfile>;
    removeQualityProfile(id: number): Promise<void>;
    createLanguageProfile(dto: CreateLanguageProfileDto): Promise<LanguageProfile>;
    findAllLanguageProfiles(): Promise<LanguageProfile[]>;
    findOneLanguageProfile(id: number): Promise<LanguageProfile>;
    updateLanguageProfile(id: number, dto: CreateLanguageProfileDto): Promise<LanguageProfile>;
    removeLanguageProfile(id: number): Promise<void>;
}
