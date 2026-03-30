import { ProfilesService } from './profiles.service';
import { CreateQualityProfileDto } from './dto/create-quality-profile.dto';
import { CreateLanguageProfileDto } from './dto/create-language-profile.dto';
import { QualityProfile } from './entities/quality-profile.entity';
import { LanguageProfile } from './entities/language-profile.entity';
export declare class ProfilesController {
    private readonly profilesService;
    constructor(profilesService: ProfilesService);
    createQuality(dto: CreateQualityProfileDto): Promise<QualityProfile>;
    findAllQuality(): Promise<QualityProfile[]>;
    findOneQuality(id: number): Promise<QualityProfile>;
    updateQuality(id: number, dto: CreateQualityProfileDto): Promise<QualityProfile>;
    removeQuality(id: number): Promise<void>;
    languageDefinitions(): import("../../common/constants/suitarr-languages").SuitarrLanguageDefinition[];
    createLanguage(dto: CreateLanguageProfileDto): Promise<LanguageProfile>;
    findAllLanguage(): Promise<LanguageProfile[]>;
    findOneLanguage(id: number): Promise<LanguageProfile>;
    updateLanguage(id: number, dto: CreateLanguageProfileDto): Promise<LanguageProfile>;
    removeLanguage(id: number): Promise<void>;
}
