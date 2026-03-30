import { BlocklistService } from './blocklist.service';
import { CreateBlocklistEntryDto } from './dto/create-blocklist-entry.dto';
export declare class BlocklistController {
    private readonly service;
    constructor(service: BlocklistService);
    create(dto: CreateBlocklistEntryDto): Promise<import("./entities/blocklist-entry.entity").BlocklistEntry>;
    findAll(page?: string, limit?: string): Promise<{
        data: import("./entities/blocklist-entry.entity").BlocklistEntry[];
        total: number;
    }>;
    clear(): Promise<{
        deleted: number;
    }>;
    remove(id: number): Promise<void>;
}
