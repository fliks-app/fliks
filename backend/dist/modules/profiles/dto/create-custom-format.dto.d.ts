declare class SpecificationDto {
    name: string;
    implementation: string;
    negate?: boolean;
    required?: boolean;
    value: string;
}
export declare class CreateCustomFormatDto {
    name: string;
    score?: number;
    specifications?: SpecificationDto[];
}
export {};
