import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as fsp from 'fs/promises';

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});
import { MAX_EDL_BYTES } from '../../streaming/edl/edl-sidecar';
import { MediaCompanionsService } from './media-companions.service';
import { SubtitlesService } from '../../subtitles/subtitles.service';

describe('MediaCompanionsService', () => {
  let root: string;
  let media: { id: number; path: string; folderName: string | null; type: string; files: { id: number; relativePath: string }[] };
  let subRows: Record<string, unknown>[];
  const subtitles = Object.assign(Object.create(SubtitlesService.prototype), {
    deleteSubtitle: jest.fn(),
  }) as SubtitlesService & { deleteSubtitle: jest.Mock };

  const build = () =>
    new MediaCompanionsService(
      { findOne: async () => media } as never,
      { find: async () => subRows } as never,
      subtitles,
    );
  const touch = (...names: string[]) => names.forEach((n) => writeFileSync(join(root, n), 'x'));
  const row = (over: Record<string, unknown>) => ({
    id: 9, relativePath: 'Film.en.srt', language: 'en', forced: false, hearingImpaired: false,
    providerType: 'disk', mediaFileId: 5, ...over,
  });
  const summary = (list: { scope: string; name: string; kind: string }[]) =>
    list.map((c) => `${c.scope}:${c.name}:${c.kind}`);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fliks-companions-'));
    media = { id: 1, path: root, folderName: 'Film', type: 'movie', files: [{ id: 5, relativePath: 'Film.mkv' }] };
    subRows = [];
    subtitles.deleteSubtitle.mockReset();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('classifies by how the app uses each file and skips other titles, dirs and links', async () => {
    touch('Film.mkv', 'Film.en.srt', 'FILM.EDL', 'Film.nfo', 'Film-poster.jpg', 'Film2.srt', 'Other.srt',
      'poster.jpg', 'movie.nfo', 'tvshow.nfo', 'notes.txt', 'Film.COM.jpg', 'Film.foo.edl', 'Film.mp4x', 'Film2.mkv');
    media.files.push({ id: 6, relativePath: 'Film2.mkv' });
    mkdirSync(join(root, 'Film.sub'));
    symlinkSync(join(root, 'notes.txt'), join(root, 'Film.link.srt'));
    const list = await build().list(1, 5);
    expect(summary(list)).toEqual([
      'file:Film-poster.jpg:image',
      'file:Film.COM.jpg:other',
      'file:FILM.EDL:edl',
      'file:Film.en.srt:subtitle',
      'file:Film.foo.edl:other',
      'file:Film.mp4x:other',
      'file:Film.nfo:nfo',
      'folder:movie.nfo:nfo',
      'folder:poster.jpg:image',
    ]);
    expect(list.find((c) => c.name === 'Film.en.srt')?.subtitle?.language).toBe('en');
  });

  it('reads tvshow.nfo, not movie.nfo, for a series', async () => {
    media.type = 'series';
    touch('Film.mkv', 'movie.nfo', 'tvshow.nfo');
    expect(summary(await build().list(1, 5))).toEqual(['folder:tvshow.nfo:nfo']);
  });

  it('omits folder-level files for a media without a folder', async () => {
    media.folderName = null;
    touch('Film.mkv', 'movie.nfo', 'poster.jpg', 'Film-poster.jpg');
    expect(summary(await build().list(1, 5))).toEqual(['file:Film-poster.jpg:image']);
  });

  it('leaves a longer-stem sibling at a library root to its own video', async () => {
    media.folderName = null;
    media.files = [{ id: 5, relativePath: 'Movie.mkv' }, { id: 6, relativePath: 'Movie.2.mkv' }];
    touch('Movie.mkv', 'Movie.2.mkv', 'Movie.en.srt', 'Movie.2.en.srt', 'Movie.2.edl', 'Movie.2.COM.jpg', 'Movie.x.jpg');
    expect(summary(await build().list(1, 5))).toEqual(['file:Movie.en.srt:subtitle', 'file:Movie.x.jpg:other']);
    expect(summary(await build().list(1, 6))).toEqual([
      'file:Movie.2.COM.jpg:other', 'file:Movie.2.edl:edl', 'file:Movie.2.en.srt:subtitle',
    ]);
  });

  it('flags files shared with a version of the same stem and deletes all rows', async () => {
    media.files.push({ id: 6, relativePath: 'Film.mp4' });
    touch('Film.mkv', 'Film.mp4', 'Film.edl', 'Film.en.srt', 'Film.fr.srt');
    subRows = [
      row({ id: 9, relativePath: 'Film.en.srt', mediaFileId: 5 }),
      row({ id: 10, relativePath: 'Film.en.srt', mediaFileId: 6 }),
      row({ id: 11, relativePath: 'Film.fr.srt', mediaFileId: 6, language: 'fr' }),
    ];
    const list = await build().list(1, 5);
    const by = (n: string) => list.find((c) => c.name === n)!;
    expect(by('Film.edl').sharedWith).toEqual([{ fileId: 6, name: 'Film.mp4' }]);
    expect(by('Film.en.srt').sharedWith).toEqual([{ fileId: 6, name: 'Film.mp4' }]);
    expect(by('Film.fr.srt').sharedWith).toEqual([{ fileId: 6, name: 'Film.mp4' }]);
    await build().remove(1, 5, 'Film.en.srt');
    expect(subtitles.deleteSubtitle.mock.calls).toEqual([[9], [10]]);
  });

  it('lists a tracked single-video-fallback subtitle under a non-matching name and deletes it by row', async () => {
    touch('Film.mkv', 'Other name.en.srt');
    subRows = [row({ id: 12, relativePath: 'Other name.en.srt' })];
    expect(summary(await build().list(1, 5))).toEqual(['file:Other name.en.srt:subtitle']);
    await build().remove(1, 5, 'Other name.en.srt');
    expect(subtitles.deleteSubtitle).toHaveBeenCalledWith(12);
  });

  it('lists an untracked sidecar the fallback would attach, none when the folder has two videos', async () => {
    touch('Film.mkv', 'Unrelated.en.srt');
    expect(summary(await build().list(1, 5))).toEqual(['file:Unrelated.en.srt:subtitle']);
    media.files.push({ id: 6, relativePath: 'Film2.mkv' });
    touch('Film2.mkv');
    expect(summary(await build().list(1, 5))).toEqual([]);
  });

  it('treats a VobSub pair as subtitles and deletes both', async () => {
    touch('Film.mkv', 'Film.en.sub', 'Film.en.idx');
    const list = await build().list(1, 5);
    expect(list.map((c) => [c.name, c.kind, c.hasPair])).toEqual([
      ['Film.en.idx', 'subtitle', true],
      ['Film.en.sub', 'subtitle', true],
    ]);
    await build().remove(1, 5, 'Film.en.idx');
    expect(existsSync(join(root, 'Film.en.idx'))).toBe(false);
    expect(existsSync(join(root, 'Film.en.sub'))).toBe(false);
  });

  it('rejects names outside its own listing', async () => {
    touch('Film.mkv', 'Film2.mkv', 'Other.srt', 'notes.txt');
    media.files.push({ id: 6, relativePath: 'Film2.mkv' });
    for (const p of ['../x', 'Film.mkv', 'Film2.mkv', 'Other.srt', 'notes.txt', '/etc/passwd']) {
      await expect(build().remove(1, 5, p)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(existsSync(join(root, 'Film.mkv'))).toBe(true);
  });

  it('unlinks an untracked file', async () => {
    touch('Film.mkv', 'FILM.edl');
    await build().remove(1, 5, 'FILM.edl', 1);
    expect(existsSync(join(root, 'FILM.edl'))).toBe(false);
  });

  describe('openForDownload', () => {
    it('streams a listed file', async () => {
      touch('Film.mkv', 'FILM.edl');
      const { name, size, stream } = await build().openForDownload(1, 5, 'FILM.edl');
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      expect([name, size, Buffer.concat(chunks).toString()]).toEqual(['FILM.edl', 1, 'x']);
    });

    it('rejects unknown and traversal paths', async () => {
      touch('Film.mkv', 'notes.txt');
      for (const p of ['../x', '/etc/passwd', 'Film.mkv', 'notes.txt']) {
        await expect(build().openForDownload(1, 5, p)).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('does not follow a link swapped in after the listing', async () => {
      touch('Film.mkv', 'Film.nfo', 'secret.txt');
      const svc = build();
      const real = (svc as never as { collect: (...a: number[]) => Promise<unknown> }).collect.bind(svc);
      (svc as never as { collect: unknown }).collect = async (...a: number[]) => {
        const out = await real(...a);
        rmSync(join(root, 'Film.nfo'));
        symlinkSync(join(root, 'secret.txt'), join(root, 'Film.nfo'));
        return out;
      };
      await expect(svc.openForDownload(1, 5, 'Film.nfo')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('importEdl', () => {
    const GOOD = Buffer.from('10.5 20 0\n30 40 1\nbad line\n');
    const edlFiles = () => readdirSync(root).filter((n) => n.toLowerCase().endsWith('.edl'));

    beforeEach(() => touch('Film.mkv'));

    it('writes Film.edl and reports ranges and ignored lines', async () => {
      const res = await build().importEdl(1, 5, GOOD, false, 3);
      expect(res.ranges).toBe(2);
      expect(res.rejected).toHaveLength(1);
      expect(readFileSync(join(root, 'Film.edl'))).toEqual(GOOD);
      expect(readdirSync(root).some((n) => n.startsWith('.fliks-tmp-'))).toBe(false);
    });

    it.each([
      ['binary', Buffer.from([49, 0, 50])],
      ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0x41])],
      ['zero ranges', Buffer.from('nonsense\n## c\n')],
      ['oversize', Buffer.alloc(MAX_EDL_BYTES + 1, 0x31)],
    ])('rejects %s without writing', async (_n, buf) => {
      await expect(build().importEdl(1, 5, buf, false)).rejects.toBeInstanceOf(BadRequestException);
      expect(edlFiles()).toEqual([]);
    });

    it('answers 409 for an existing file, then replaces it with replace=true', async () => {
      writeFileSync(join(root, 'Film.edl'), '1 2 0\n');
      await expect(build().importEdl(1, 5, GOOD, false)).rejects.toBeInstanceOf(ConflictException);
      expect(readFileSync(join(root, 'Film.edl'), 'utf8')).toBe('1 2 0\n');
      await build().importEdl(1, 5, GOOD, true);
      expect(readFileSync(join(root, 'Film.edl'))).toEqual(GOOD);
    });

    it('accepts a BOM and CRLF line endings', async () => {
      const buf = Buffer.from('\ufeff10.5 20 0\r\n30 40 1\r\n');
      const res = await build().importEdl(1, 5, buf, false);
      expect(res).toEqual({ ranges: 2, rejected: [] });
      expect(readFileSync(join(root, 'Film.edl'))).toEqual(buf);
    });

    it('does not overwrite a file that appeared after the existence check', async () => {
      const svc = build();
      const open = fsp.open as jest.Mock;
      const orig = open.getMockImplementation()!;
      open.mockImplementationOnce(async (...a: unknown[]) => {
        writeFileSync(join(root, 'Film.edl'), '1 2 0\n');
        return orig(...a);
      });
      await expect(svc.importEdl(1, 5, GOOD, false)).rejects.toBeInstanceOf(ConflictException);
      expect(readFileSync(join(root, 'Film.edl'), 'utf8')).toBe('1 2 0\n');
    });

    it('replaces an existing file of another letter case instead of adding a second', async () => {
      writeFileSync(join(root, 'FILM.EDL'), '1 2 0\n');
      await build().importEdl(1, 5, GOOD, true);
      expect(edlFiles()).toEqual(['FILM.EDL']);
      expect(readFileSync(join(root, 'FILM.EDL'))).toEqual(GOOD);
    });
  });
});
