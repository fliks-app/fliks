import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiskImportService } from './disk-import.service';
import { MediaType } from '../../common/enums';

const library = { id: 1, name: 'Movies', path: '/media', mediaTypes: [MediaType.MOVIE] };

function makeService() {
  const mediaRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 1, type: MediaType.MOVIE, library }),
    update: jest.fn(),
  };
  const libraries = { requirePathFor: jest.fn().mockResolvedValue(library) };
  const naming = {
    getFormats: jest.fn().mockResolvedValue({ movieFolder: '{title}' }),
    applyMovieFolderFormat: () => 'Sample Movie (2009)',
  };
  const libraryIngest = { ingest: jest.fn() };
  const mediaServers = { dispatch: jest.fn() };
  const service = new DiskImportService(
    mediaRepo as never,
    null as never, // fileRepo
    null as never, // seasonRepo
    null as never, // mediaService
    naming as never,
    libraries as never,
    null as never, // metadata
    { readForVideoFile: jest.fn(), readNfoFile: jest.fn() } as never,
    libraryIngest as never,
    { enqueue: jest.fn() } as never,
    mediaServers as never,
    { emit: jest.fn(), emitDomain: jest.fn() } as never,
    { upsertPending: jest.fn(), upsertRunning: jest.fn(), remove: jest.fn() } as never,
  );
  return { service, libraryIngest };
}

describe('DiskImportService.confirmImport: source validation', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-import-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a non-video source file before it ever reaches the ingest pipeline', async () => {
    const { service, libraryIngest } = makeService();
    const notVideo = path.join(dir, 'notes.txt');
    fs.writeFileSync(notVideo, 'not a video');

    const res = await service.confirmImport(
      [{ filePath: notVideo, mediaId: 1, quality: '', targetLibraryId: 1 }],
      'copy',
    );

    expect(res.imported).toBe(0);
    expect(res.errors[0]).toContain('not a video file');
    expect(libraryIngest.ingest).not.toHaveBeenCalled();
  });

  it('rejects a directory even when it is named like a video file', async () => {
    const { service, libraryIngest } = makeService();
    const fakeVideoDir = path.join(dir, 'movie.mkv');
    fs.mkdirSync(fakeVideoDir);

    const res = await service.confirmImport(
      [{ filePath: fakeVideoDir, mediaId: 1, quality: '', targetLibraryId: 1 }],
      'copy',
    );

    expect(res.imported).toBe(0);
    expect(res.errors[0]).toContain('not a video file');
    expect(libraryIngest.ingest).not.toHaveBeenCalled();
  });

  it('accepts a regular file with a known video extension', async () => {
    const { service, libraryIngest } = makeService();
    const video = path.join(dir, 'movie.mkv');
    fs.writeFileSync(video, 'x');
    libraryIngest.ingest.mockResolvedValue({
      imported: [{ file: {}, sourcePath: video }],
      alreadyPresent: [],
    });

    const res = await service.confirmImport(
      [{ filePath: video, mediaId: 1, quality: '', targetLibraryId: 1 }],
      'copy',
    );

    expect(res.errors).toEqual([]);
    expect(res.imported).toBe(1);
    expect(libraryIngest.ingest).toHaveBeenCalled();
  });
});
