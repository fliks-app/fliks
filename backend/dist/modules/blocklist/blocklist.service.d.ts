import { Repository } from 'typeorm';
import { BlocklistEntry } from './entities/blocklist-entry.entity';
import { CreateBlocklistEntryDto } from './dto/create-blocklist-entry.dto';
export declare class BlocklistService {
    private readonly repo;
    constructor(repo: Repository<BlocklistEntry>);
    create(dto: CreateBlocklistEntryDto): Promise<BlocklistEntry>;
    findAll(page?: number, limit?: number): Promise<{
        data: BlocklistEntry[];
        total: number;
    }>;
    isBlocked(sourceTitle: string): Promise<boolean>;
    remove(id: number): Promise<void>;
    clear(): Promise<{
        deleted: number;
    }>;
}
