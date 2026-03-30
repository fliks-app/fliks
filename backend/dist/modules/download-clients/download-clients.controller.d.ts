import { DownloadClientsService } from './download-clients.service';
import { CreateDownloadClientDto } from './dto/create-download-client.dto';
import { UpdateDownloadClientDto } from './dto/update-download-client.dto';
import { TestDownloadClientDto } from './dto/test-download-client.dto';
import { DownloadClient } from './entities/download-client.entity';
export declare class DownloadClientsController {
    private readonly service;
    constructor(service: DownloadClientsService);
    testConnection(dto: TestDownloadClientDto): Promise<{
        ok: boolean;
        message: string;
    }>;
    create(dto: CreateDownloadClientDto): Promise<DownloadClient>;
    findAll(): Promise<DownloadClient[]>;
    queue(): Promise<import("./download-clients.service").QueueEntry[]>;
    removeTorrent(hash: string, clientId: number, deleteFiles?: string): Promise<void>;
    findOne(id: number): Promise<DownloadClient>;
    update(id: number, dto: UpdateDownloadClientDto): Promise<DownloadClient>;
    remove(id: number): Promise<void>;
}
