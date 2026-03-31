import { QualityDefinitionsService } from './quality-definitions.service';
import { UpdateQualityDefinitionsDto } from './dto/update-quality-definitions.dto';
export declare class QualityDefinitionsController {
    private readonly service;
    constructor(service: QualityDefinitionsService);
    findAll(): Promise<import("./entities/quality-definition.entity").QualityDefinition[]>;
    updateAll(dto: UpdateQualityDefinitionsDto): Promise<import("./entities/quality-definition.entity").QualityDefinition[]>;
}
