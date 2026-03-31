import { OnModuleInit } from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { QualityDefinitionsService } from './quality-definitions.service';
export declare class ProfilesModule implements OnModuleInit {
    private readonly profiles;
    private readonly qualityDefs;
    constructor(profiles: ProfilesService, qualityDefs: QualityDefinitionsService);
    onModuleInit(): void;
}
