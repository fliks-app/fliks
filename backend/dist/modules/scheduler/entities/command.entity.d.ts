import { BaseEntity } from '../../../common/entities/base.entity';
export declare class Command extends BaseEntity {
    name: string;
    status: string;
    startedOn: Date;
    endedOn: Date;
    trigger: string;
    body: Record<string, unknown>;
}
