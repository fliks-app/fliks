import { Repository } from 'typeorm';
import { DelayProfile } from './entities/delay-profile.entity';
import { CreateDelayProfileDto } from './dto/create-delay-profile.dto';
import { Tag } from '../tags/entities/tag.entity';
export declare class DelayProfilesController {
    private readonly repo;
    private readonly tagRepo;
    constructor(repo: Repository<DelayProfile>, tagRepo: Repository<Tag>);
    findAll(): Promise<DelayProfile[]>;
    create(dto: CreateDelayProfileDto): Promise<DelayProfile>;
    update(id: number, dto: CreateDelayProfileDto): Promise<DelayProfile>;
    remove(id: number): Promise<void>;
}
