import { mkdtempSync, rmSync, promises as fsp, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { createHash } from 'crypto';
import axios from 'axios';
import sharp from 'sharp';
import { ImageService } from './image.service';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

describe('ImageService.downloadAndStore caching', () => {
  let dir: string;
  let service: ImageService;
  let fixture: Buffer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fliks-image-test-'));
    process.env.FLIKS_DATA_DIR = dir;
    service = new ImageService();

    // A real decodable JPEG, sharp must actually resize it for the
    // sized-variant files the cache check looks for to exist.
    fixture = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({ data: fixture });
  });

  it('downloads and resizes on a cold call', async () => {
    const result = await service.downloadAndStore(
      'https://image.tmdb.org/t/p/original/cold.jpg',
      'person',
      1,
    );
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/^\/api\/images\/person\/1\?v=[0-9a-f]{8}$/);
  });

  it('skips the download and resize on a repeat call with the same URL', async () => {
    const url = 'https://image.tmdb.org/t/p/original/same.jpg';
    const first = await service.downloadAndStore(url, 'person', 2);
    const second = await service.downloadAndStore(url, 'person', 2);

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('re-downloads when the URL changes', async () => {
    await service.downloadAndStore(
      'https://image.tmdb.org/t/p/original/first.jpg',
      'person',
      3,
    );
    await service.downloadAndStore(
      'https://image.tmdb.org/t/p/original/second.jpg',
      'person',
      3,
    );

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('re-downloads when a sized variant is missing on disk', async () => {
    const url = 'https://image.tmdb.org/t/p/original/thumb-missing.jpg';
    await service.downloadAndStore(url, 'person', 4);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);

    rmSync(service.getDiskPath('person', 4, undefined, 'thumb'));

    await service.downloadAndStore(url, 'person', 4);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('serializes two concurrent calls for the same target so the bytes and sidecar agree', async () => {
    const urlA = 'https://image.tmdb.org/t/p/original/race-a.jpg';
    const urlB = 'https://image.tmdb.org/t/p/original/race-b.jpg';
    const bufferB = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .jpeg()
      .toBuffer();

    mockedAxios.get.mockImplementation(async (url: unknown) => {
      await new Promise((r) => setTimeout(r, 5));
      return { data: String(url).includes('race-a') ? fixture : bufferB };
    });

    const [resultA, resultB] = await Promise.all([
      service.downloadAndStore(urlA, 'person', 5),
      service.downloadAndStore(urlB, 'person', 5),
    ]);

    // The second call joined the first instead of racing it: one download only.
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(resultA).toBe(resultB);

    const fullPath = service.getDiskPath('person', 5);
    const srcPath = fullPath.slice(0, -extname(fullPath).length) + '.src.json';
    const meta = JSON.parse(await fsp.readFile(srcPath, 'utf8')) as {
      url: string;
      hash: string;
    };
    const bytesOnDisk = await fsp.readFile(fullPath);
    const hash = createHash('sha1').update(bytesOnDisk).digest('hex').slice(0, 8);
    expect(meta.hash).toBe(hash);
    expect([urlA, urlB]).toContain(meta.url);
  });
});

describe('ImageService.storeFromDisk', () => {
  let dir: string;
  let srcDir: string;
  let service: ImageService;
  let fixturePath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fliks-image-disk-test-'));
    srcDir = mkdtempSync(join(tmpdir(), 'fliks-image-disk-src-'));
    process.env.FLIKS_DATA_DIR = dir;
    service = new ImageService();

    const fixture = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    fixturePath = join(srcDir, 'poster.jpg');
    writeFileSync(fixturePath, fixture);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('writes the full image, its resized variants and the sidecar', async () => {
    const result = await service.storeFromDisk(fixturePath, 'media', 10, 'poster');
    expect(result).toMatch(/^\/api\/images\/media\/10\/poster\?v=[0-9a-f]{8}$/);

    await fsp.access(service.getDiskPath('media', 10, 'poster', 'full'));
    await fsp.access(service.getDiskPath('media', 10, 'poster', 'thumb'));
    await fsp.access(service.getDiskPath('media', 10, 'poster', 'medium'));
  });

  it('is a cache hit on a second call with an unchanged file', async () => {
    const spy = jest.spyOn(sharp.prototype as never, 'toBuffer' as never);
    const first = await service.storeFromDisk(fixturePath, 'media', 11, 'poster');
    spy.mockClear();
    const second = await service.storeFromDisk(fixturePath, 'media', 11, 'poster');

    expect(second).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns null for a path that cannot be read', async () => {
    const result = await service.storeFromDisk(
      join(srcDir, 'missing.jpg'),
      'media',
      12,
      'poster',
    );
    expect(result).toBeNull();
  });

  it('returns null for a file sharp cannot decode as an image', async () => {
    const badPath = join(srcDir, 'not-an-image.jpg');
    writeFileSync(badPath, 'this is not image bytes');

    const result = await service.storeFromDisk(badPath, 'media', 13, 'poster');
    expect(result).toBeNull();
  });
});
