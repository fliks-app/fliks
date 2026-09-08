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

  function write(name: string) {
    fs.writeFileSync(path.join(backups, name), '-- dump');
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
});
