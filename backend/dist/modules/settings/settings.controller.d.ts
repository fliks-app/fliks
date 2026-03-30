import { SettingsService } from './settings.service';
declare class SetSettingDto {
    value: string | null;
}
declare class SetBulkDto {
    data: Record<string, string | null>;
}
export declare class SettingsController {
    private readonly service;
    constructor(service: SettingsService);
    getAll(): Promise<Record<string, string | null>>;
    getOne(key: string): Promise<{
        key: string;
        value: string | null;
    }>;
    setOne(key: string, dto: SetSettingDto): Promise<import("./entities/app-setting.entity").AppSetting>;
    setBulk(dto: SetBulkDto): Promise<{
        ok: boolean;
    }>;
}
export {};
