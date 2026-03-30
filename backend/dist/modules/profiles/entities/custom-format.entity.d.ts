import { BaseEntity } from '../../../common/entities/base.entity';
export declare class CustomFormat extends BaseEntity {
    name: string;
    score: number;
    specifications: CustomFormatSpecification[];
}
export interface CustomFormatSpecification {
    name: string;
    implementation: string;
    negate: boolean;
    required: boolean;
    value: string;
}
