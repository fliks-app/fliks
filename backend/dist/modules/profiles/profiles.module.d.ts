import { OnModuleInit } from '@nestjs/common';
import { ProfilesService } from './profiles.service';
export declare class ProfilesModule implements OnModuleInit {
    private readonly profiles;
    constructor(profiles: ProfilesService);
    onModuleInit(): void;
}
