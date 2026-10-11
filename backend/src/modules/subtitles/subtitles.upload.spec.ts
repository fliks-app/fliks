import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { SubtitlesService, sidecarLangSuffix } from './subtitles.service';

const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');

function harness(dir: string, file: Record<string, unknown> = { id: 5, mediaId: 1, episodeId: null, relativePath: 'Film.mkv' }) {
  const service = Object.create(SubtitlesService.prototype) as SubtitlesService;
  const repo = { save: jest.fn((x) => Promise.resolve(x)) };
  const w = service as unknown as Record<string, unknown>;
  w.mediaRepo = { findOne: jest.fn().mockResolvedValue({ id: 1, path: dir }) };
  w.mediaFileRepo = { findOne: jest.fn().mockResolvedValue(file) };
  w.settingsService = { get: jest.fn().mockResolvedValue('false') };
  w.repo = repo;
  w.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, repo };
}

describe('sidecarLangSuffix', () => {
  it('lets forced win over hearing-impaired', () => {
    expect(sidecarLangSuffix('en', false, false)).toBe('en');
    expect(sidecarLangSuffix('en', true, true)).toBe('en.forced');
    expect(sidecarLangSuffix('en', false, true)).toBe('en.hi');
  });
});

describe('SubtitlesService.uploadSubtitle', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'fliks-sub-upload-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('derives the flags from the filename when no override is given', async () => {
    const { service, repo } = harness(dir);
    await service.uploadSubtitle(1, 5, undefined, { originalname: 'Film.en.forced.srt', buffer: SRT }, 'en');
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ forced: true, hearingImpaired: false }));
    expect(readdirSync(dir)).toEqual(['Film.en.forced.srt']);
  });

  it('lets explicit flags override the filename, in both directions', async () => {
    const { service, repo } = harness(dir);
    await service.uploadSubtitle(
      1, 5, undefined, { originalname: 'Film.en.forced.srt', buffer: SRT }, 'en',
      { forced: false, hearingImpaired: true },
    );
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ forced: false, hearingImpaired: true }));
    expect(readdirSync(dir)).toEqual(['Film.en.hi.srt']);
  });

  it('refuses a media file of another media or episode', async () => {
    await expect(
      harness(dir, { id: 5, mediaId: 2, episodeId: null, relativePath: 'Film.mkv' }).service.uploadSubtitle(
        1, 5, undefined, { originalname: 'a.srt', buffer: SRT }, 'en',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      harness(dir, { id: 5, mediaId: 1, episodeId: 9, relativePath: 'Film.mkv' }).service.uploadSubtitle(
        1, 5, 8, { originalname: 'a.srt', buffer: SRT }, 'en',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(readdirSync(dir)).toEqual([]);
  });
});
