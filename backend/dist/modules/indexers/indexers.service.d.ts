import { Repository } from 'typeorm';
import { Indexer } from './entities/indexer.entity';
import { Tag } from '../tags/entities/tag.entity';
import { CreateIndexerDto } from './dto/create-indexer.dto';
import { UpdateIndexerDto } from './dto/update-indexer.dto';
import { TorznabService } from './torznab.service';
import { TestIndexerConnectionDto } from './dto/test-indexer-connection.dto';
export declare class IndexersService {
    private readonly indexerRepo;
    private readonly tagRepo;
    private readonly torznab;
    constructor(indexerRepo: Repository<Indexer>, tagRepo: Repository<Tag>, torznab: TorznabService);
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
