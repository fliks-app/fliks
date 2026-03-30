import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { Tag } from './entities/tag.entity';
export declare class TagsController {
    private readonly tagsService;
    constructor(tagsService: TagsService);
    create(dto: CreateTagDto): Promise<Tag>;
    findAll(): Promise<Tag[]>;
    findOne(id: number): Promise<Tag>;
    update(id: number, dto: CreateTagDto): Promise<Tag>;
    remove(id: number): Promise<void>;
}
