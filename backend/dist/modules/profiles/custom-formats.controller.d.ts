import { CustomFormatsService } from './custom-formats.service';
import { CreateCustomFormatDto } from './dto/create-custom-format.dto';
export declare class CustomFormatsController {
    private readonly service;
    constructor(service: CustomFormatsService);
    create(dto: CreateCustomFormatDto): Promise<import("./entities/custom-format.entity").CustomFormat>;
    findAll(): Promise<import("./entities/custom-format.entity").CustomFormat[]>;
    findOne(id: number): Promise<import("./entities/custom-format.entity").CustomFormat>;
    update(id: number, dto: CreateCustomFormatDto): Promise<import("./entities/custom-format.entity").CustomFormat>;
    remove(id: number): Promise<void>;
}
