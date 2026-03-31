import { ConfigService } from '@nestjs/config';
export declare class BackupService {
    private readonly config;
    private readonly log;
    private readonly backupDir;
    constructor(config: ConfigService);
    createBackup(): Promise<{
        filename: string;
        size: number;
    }>;
    listBackups(): {
        filename: string;
        size: number;
        date: string;
    }[];
    restore(filename: string): Promise<void>;
    getBackupPath(filename: string): string;
}
