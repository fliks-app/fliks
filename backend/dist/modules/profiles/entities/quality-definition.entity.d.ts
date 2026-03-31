import { BaseEntity } from '../../../common/entities/base.entity';
export declare class QualityDefinition extends BaseEntity {
    qualityId: number;
    title: string;
    minSize: number;
    preferredSize: number;
    maxSize: number;
}
