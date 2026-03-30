import { BaseEntity } from '../../../common/entities/base.entity';
import { UserRole, MediaServerType } from '../../../common/enums';
export declare class User extends BaseEntity {
    username: string;
    email: string;
    passwordHash: string;
    role: UserRole;
    apiKey: string;
    mediaServerType: MediaServerType;
    mediaServerId: string;
    avatar: string;
    lastLogin: Date;
    enabled: boolean;
    movieQuotaLimit: number;
    seriesQuotaLimit: number;
    quotaPeriodDays: number;
}
