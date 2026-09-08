import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupService } from './backup.service';

describe('BackupService', () => {
  let dir: string;
  let backups: string;
  let service: BackupService;

  beforeAll(() => {
    // getDataDir() caches its probe process-wide, so the env has to be set
    // before the first instance and the directory reused after that.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-backup-spec-'));
    process.env.FLIKS_DATA_DIR = dir;
    service = new BackupService(new ConfigService());
    backups = path.join(dir, 'backups');
  });

  beforeEach(() => {
    fs.rmSync(backups, { recursive: true, force: true });
    fs.mkdirSync(backups, { recursive: true });
  });

  afterAll(() => {
    delete process.env.FLIKS_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, day?: number) {
    const file = path.join(backups, name);
    fs.writeFileSync(file, '-- dump');
    if (day !== undefined) {
      // listBackups orders on mtime, which every file here would share.
      const when = new Date(2026, 0, day);
      fs.utimesSync(file, when, when);
    }
  }

  describe('getBackupPath', () => {
    it('resolves a backup that exists', () => {
      write('fliks-backup-1.sql');
      expect(service.getBackupPath('fliks-backup-1.sql')).toBe(
        path.join(backups, 'fliks-backup-1.sql'),
      );
    });

    it.each(['../../etc/passwd', '/etc/passwd', 'sub/dir.sql', 'dump.sql.gz'])(
      'rejects %s',
      (name) => {
        expect(() => service.getBackupPath(name)).toThrow(BadRequestException);
      },
    );

    it('reports a missing backup as not found', () => {
      expect(() => service.getBackupPath('absent.sql')).toThrow(
        NotFoundException,
      );
    });
  });

  describe('pruneOldBackups', () => {
    it('keeps the seven newest and removes the rest', () => {
      for (let day = 1; day <= 9; day++) write(`fliks-backup-${day}.sql`, day);

      expect(service.pruneOldBackups()).toEqual([
        'fliks-backup-2.sql',
        'fliks-backup-1.sql',
      ]);
      expect(fs.readdirSync(backups).sort()).toEqual([
        'fliks-backup-3.sql',
        'fliks-backup-4.sql',
        'fliks-backup-5.sql',
        'fliks-backup-6.sql',
        'fliks-backup-7.sql',
        'fliks-backup-8.sql',
        'fliks-backup-9.sql',
      ]);
    });

    it('removes nothing when under the retention window', () => {
      for (let day = 1; day <= 3; day++) write(`fliks-backup-${day}.sql`, day);
      expect(service.pruneOldBackups()).toEqual([]);
      expect(fs.readdirSync(backups)).toHaveLength(3);
    });
  });
});
