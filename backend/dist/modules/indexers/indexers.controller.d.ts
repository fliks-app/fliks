import { IndexersService } from './indexers.service';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';
import { Indexer } from './entities/indexer.entity';
export declare class IndexersController {
    private readonly indexersService;
    constructor(indexersService: IndexersService);
    testConnection(dto: TestIndexerConnectionDto): Promise<{
        ok: boolean;
        message: string;
    }>;
    create(dto: CreateIndexerDto): Promise<Indexer>;
    findAll(): Promise<Indexer[]>;
    findOne(id: number): Promise<Indexer>;
    update(id: number, dto: UpdateIndexerDto): Promise<Indexer>;
    remove(id: number): Promise<void>;
}
