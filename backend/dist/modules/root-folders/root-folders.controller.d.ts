import { RootFoldersService } from './root-folders.service';
import { CreateRootFolderDto } from './dto/create-root-folder.dto';
export declare class RootFoldersController {
    private readonly service;
    constructor(service: RootFoldersService);
    create(dto: CreateRootFolderDto): Promise<{
        accessible: boolean;
        freeSpace: number;
        totalSpace: number;
        path: string;
        label: string;
        id: number;
        createdAt: Date;
        updatedAt: Date;
    }>;
    findAll(): Promise<{
        accessible: boolean;
        freeSpace: number;
        totalSpace: number;
        path: string;
        label: string;
        id: number;
        createdAt: Date;
        updatedAt: Date;
    }[]>;
    findOne(id: number): Promise<{
        accessible: boolean;
        freeSpace: number;
        totalSpace: number;
        path: string;
        label: string;
        id: number;
        createdAt: Date;
        updatedAt: Date;
    }>;
    remove(id: number): Promise<void>;
}
