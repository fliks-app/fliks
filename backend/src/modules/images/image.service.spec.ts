import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

    // A real decodable JPEG — sharp must actually resize it for the
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
});
