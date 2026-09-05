import { mkdtempSync, rmSync, promises as fsp } from 'fs';
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
    process.env.FLIKS_IMAGES_DIR = dir;
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
