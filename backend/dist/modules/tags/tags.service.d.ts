import { Repository } from 'typeorm';
import { Tag } from './entities/tag.entity';
import { CreateTagDto } from './dto/create-tag.dto';
export declare class TagsService {
    private readonly tagRepo;
    constructor(tagRepo: Repository<Tag>);
    create(dto: CreateTagDto): Promise<Tag>;
    findAll(): Promise<Tag[]>;
    findOne(id: number): Promise<Tag>;
    update(id: number, dto: CreateTagDto): Promise<Tag>;
    remove(id: number): Promise<void>;
}
