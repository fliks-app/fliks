import { Repository } from 'typeorm';
import { RemotePathMapping } from './entities/remote-path-mapping.entity';
import { CreateRemotePathMappingDto } from './dto/create-remote-path-mapping.dto';
export declare class RemotePathMappingsController {
    private readonly repo;
    constructor(repo: Repository<RemotePathMapping>);
    create(dto: CreateRemotePathMappingDto): Promise<RemotePathMapping>;
    findAll(): Promise<RemotePathMapping[]>;
    remove(id: number): Promise<{
        ok: boolean;
    }>;
}
