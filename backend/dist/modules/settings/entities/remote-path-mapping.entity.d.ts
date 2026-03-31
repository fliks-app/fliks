import { BaseEntity } from '../../../common/entities/base.entity';
export declare class RemotePathMapping extends BaseEntity {
    downloadClientId: number;
    remotePath: string;
    localPath: string;
}
