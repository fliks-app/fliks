import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class BackupService {
  private readonly log = new Logger(BackupService.name);
  private readonly backupDir: string;

  constructor(private readonly config: ConfigService) {
    this.backupDir = path.join(process.cwd(), 'backups');
  }

  async createBackup(): Promise<{ filename: string; size: number }> {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `suitarr-backup-${timestamp}.sql`;
    const filePath = path.join(this.backupDir, filename);

    const dbUrl = this.config.get<string>('DATABASE_URL', '');
    if (!dbUrl) {
      throw new Error('DATABASE_URL not configured');
    }

    this.log.log(`Creating backup: ${filename}`);
    await execAsync(`pg_dump "${dbUrl}" > "${filePath}"`);

    const stat = fs.statSync(filePath);
    this.log.log(`Backup created: ${filename} (${stat.size} bytes)`);
    return { filename, size: stat.size };
  }

  listBackups(): { filename: string; size: number; date: string }[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.sql'))
      .map((filename) => {
        const stat = fs.statSync(path.join(this.backupDir, filename));
        return { filename, size: stat.size, date: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async restore(filename: string): Promise<void> {
    const filePath = path.join(this.backupDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Backup "${filename}" not found`);
    }

    const dbUrl = this.config.get<string>('DATABASE_URL', '');
    if (!dbUrl) {
      throw new Error('DATABASE_URL not configured');
    }

    this.log.warn(`Restoring backup: ${filename}`);
    await execAsync(`psql "${dbUrl}" < "${filePath}"`);
    this.log.log(`Backup restored: ${filename}`);
  }

  getBackupPath(filename: string): string {
    const filePath = path.join(this.backupDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Backup "${filename}" not found`);
    }
    return filePath;
  }
}
