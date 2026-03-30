import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaServerType } from '../../../common/enums';
export declare class MediaServer extends BaseEntity {
    name: string;
    type: MediaServerType;
    url: string;
    apiKey: string;
    enabled: boolean;
}
