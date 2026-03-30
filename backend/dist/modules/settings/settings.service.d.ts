import { Repository } from 'typeorm';
import { AppSetting } from './entities/app-setting.entity';
export declare class SettingsService {
    private readonly repo;
    constructor(repo: Repository<AppSetting>);
    getAll(): Promise<Record<string, string | null>>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string | null): Promise<AppSetting>;
    setBulk(data: Record<string, string | null>): Promise<void>;
    delete(key: string): Promise<void>;
}
