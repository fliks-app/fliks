import { Repository } from 'typeorm';
import { CustomFormat } from './entities/custom-format.entity';
import { CreateCustomFormatDto } from './dto/create-custom-format.dto';
export declare class CustomFormatsService {
    private readonly repo;
    constructor(repo: Repository<CustomFormat>);
    create(dto: CreateCustomFormatDto): Promise<CustomFormat>;
    findAll(): Promise<CustomFormat[]>;
    findOne(id: number): Promise<CustomFormat>;
    update(id: number, dto: CreateCustomFormatDto): Promise<CustomFormat>;
    remove(id: number): Promise<void>;
    testRelease(title: string, meta?: {
        freeleech?: boolean;
        downloadVolumeFactor?: number;
    }): Promise<{
        formatId: number;
        formatName: string;
        matched: boolean;
        score: number;
    }[]>;
    scoreRelease(releaseTitle: string, meta?: {
        freeleech?: boolean;
        downloadVolumeFactor?: number;
    }): Promise<number>;
    private matchesFormat;
    private evalSpec;
}
