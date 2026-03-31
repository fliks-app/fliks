import { Repository } from 'typeorm';
import { IndexersService } from './indexers.service';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';
import { Indexer } from './entities/indexer.entity';
import { IndexerStat } from './entities/indexer-stat.entity';
export declare class IndexersController {
    private readonly indexersService;
    private readonly statRepo;
    constructor(indexersService: IndexersService, statRepo: Repository<IndexerStat>);
    testConnection(dto: TestIndexerConnectionDto): Promise<{
        ok: boolean;
        message: string;
    }>;
    create(dto: CreateIndexerDto): Promise<Indexer>;
    findAll(): Promise<Indexer[]>;
    findOne(id: number): Promise<Indexer>;
    update(id: number, dto: UpdateIndexerDto): Promise<Indexer>;
    remove(id: number): Promise<void>;
    getStats(id: number): Promise<any[]>;
}
