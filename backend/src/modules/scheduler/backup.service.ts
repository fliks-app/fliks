import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../../common/constants/paths';

/**
 * Whole-database dump and restore through the postgres client tools.
 *
 * Connection settings come from the same `DB_*` variables TypeORM reads, so the
 * two can never point at different databases. The password travels in
 * `PGPASSWORD` and the tools are spawned without a shell: no quoting of
 * credentials, nothing for a value to escape into.
 */
@Injectable()
export class BackupService {
  private readonly log = new Logger(BackupService.name);
  /** Under the data dir, so backups survive an image upgrade. */
  private readonly backupDir = path.join(getDataDir(), 'backups');

  constructor(private readonly config: ConfigService) {}

  async createBackup(): Promise<{ filename: string; size: number }> {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `fliks-backup-${timestamp}.sql`;
    const filePath = path.join(this.backupDir, filename);

    this.log.log(`Creating backup: ${filename}`);
    const fd = fs.openSync(filePath, 'w');
    try {
      // --clean --if-exists: the restore runs against a populated database.
      await this.run(
        'pg_dump',
        [...this.connectionArgs(), '--clean', '--if-exists', '--no-owner'],
        fd,
      );
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(filePath, { force: true });
      throw err;
    }
    fs.closeSync(fd);

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
    const filePath = this.getBackupPath(filename);
    this.log.warn(`Restoring backup: ${filename}`);
    // ON_ERROR_STOP: without it psql reports success after skipping every
    // statement that failed, leaving a half-restored database.
    await this.run('psql', [
      ...this.connectionArgs(),
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      filePath,
    ]);
    this.log.log(`Backup restored: ${filename}`);
  }

  /** Resolved inside the backup dir: the name reaches here from a request. */
  getBackupPath(filename: string): string {
    if (!/^[\w.-]+\.sql$/.test(filename)) {
      throw new BadRequestException(`Invalid backup name "${filename}"`);
    }
    const filePath = path.join(this.backupDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Backup "${filename}" not found`);
    }
    return filePath;
  }

  private connectionArgs(): string[] {
    return [
      '-h',
      this.config.get<string>('DB_HOST', 'localhost'),
      '-p',
      String(this.config.get<number>('DB_PORT', 5432)),
      '-U',
      this.config.get<string>('DB_USERNAME', 'fliks'),
      '-d',
      this.config.get<string>('DB_NAME', 'fliks'),
    ];
  }

  /** Spawn a postgres tool, optionally writing its stdout to `outFd`. Rejects
   *  with the tool's own last stderr line, which is what the UI shows. */
  private run(cmd: string, args: string[], outFd?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', outFd ?? 'ignore', 'pipe'],
        env: {
          ...process.env,
          PGPASSWORD: this.config.get<string>('DB_PASSWORD', ''),
        },
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          new InternalServerErrorException(
            err.code === 'ENOENT'
              ? `${cmd} is not available on this server`
              : `${cmd} failed: ${err.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) return resolve();
        const detail = stderr.trim().split('\n').filter(Boolean).pop();
        this.log.error(`${cmd} exited with ${code}: ${stderr.trim()}`);
        reject(
          new InternalServerErrorException(
            detail ?? `${cmd} exited with code ${code}`,
          ),
        );
      });
    });
  }
}
