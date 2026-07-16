import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FilesystemService } from './filesystem.service';

describe('FilesystemService', () => {
  const service = new FilesystemService();
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-fs-test-'));
    fs.mkdirSync(path.join(root, 'movies'));
    fs.mkdirSync(path.join(root, 'series'));
    fs.writeFileSync(path.join(root, 'note.txt'), 'x');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists only sub-directories, sorted, with absolute paths', () => {
    const listing = service.list(root);
    expect(listing.current).toBe(path.resolve(root));
    expect(listing.entries.map((e) => e.name)).toEqual(['movies', 'series']);
    expect(listing.entries.every((e) => e.isDirectory)).toBe(true);
    expect(listing.entries[0].path).toBe(path.join(root, 'movies'));
  });

  it('exposes the parent directory', () => {
    const listing = service.list(root);
    expect(listing.parent).toBe(path.dirname(path.resolve(root)));
  });

  it('throws on a path that does not exist', () => {
    expect(() => service.list(path.join(root, 'nope'))).toThrow(
      BadRequestException,
    );
  });

  it('returns the roots view when no path is given', () => {
    // On this POSIX host the roots view lists `/`.
    const listing = service.list();
    expect(listing.current).toBe('/');
    expect(Array.isArray(listing.entries)).toBe(true);
  });
});
