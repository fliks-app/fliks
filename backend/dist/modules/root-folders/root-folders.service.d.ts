import { Repository } from 'typeorm';
import { RootFolder } from './entities/root-folder.entity';
import { CreateRootFolderDto } from './dto/create-root-folder.dto';
export declare class RootFoldersService {
    private readonly repo;
    constructor(repo: Repository<RootFolder>);
    private diskInfo;
    private enrich;
    create(dto: CreateRootFolderDto): Promise<ReturnType<typeof this.enrich>>;
    findAll(): Promise<ReturnType<typeof this.enrich>[]>;
    findOne(id: number): Promise<ReturnType<typeof this.enrich>>;
    remove(id: number): Promise<void>;
}
