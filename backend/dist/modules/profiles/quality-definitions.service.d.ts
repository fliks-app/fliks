import { Repository } from 'typeorm';
import { QualityDefinition } from './entities/quality-definition.entity';
import { QualityDefinitionItemDto } from './dto/update-quality-definitions.dto';
export declare class QualityDefinitionsService {
    private readonly repo;
    private readonly log;
    constructor(repo: Repository<QualityDefinition>);
    ensureDefaults(): Promise<void>;
    findAll(): Promise<QualityDefinition[]>;
    updateAll(items: QualityDefinitionItemDto[]): Promise<QualityDefinition[]>;
    getSizeLimitsMap(): Promise<Map<number, {
        min: number;
        preferred: number;
        max: number;
    }>>;
}
