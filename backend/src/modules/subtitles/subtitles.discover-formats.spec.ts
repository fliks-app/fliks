import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SubtitlesService } from './subtitles.service';

function harness(dir: string) {
  const service = Object.create(SubtitlesService.prototype) as SubtitlesService;
  const repo = { find: jest.fn().mockResolvedValue([]), save: jest.fn() };
  const wired = service as unknown as Record<string, unknown>;
  wired.mediaRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: 1,
      folderName: '',
      path: dir,
      files: [{ id: 1, relativePath: 'movie.mkv', episodeId: null }],
    }),
  };
  wired.repo = repo;
  wired.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, repo };
}

describe('SubtitlesService.discoverExternalSubtitles - formats', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fliks-subtitle-formats-'));
    writeFileSync(join(dir, 'movie.mkv'), '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const saved = async (...files: string[]) => {
    for (const f of files) writeFileSync(join(dir, f), '');
    const { service, repo } = harness(dir);
    await service.discoverExternalSubtitles(1);
    const rows = repo.save.mock.calls as [
      { relativePath: string; codec: string | null },
    ][];
    return Object.fromEntries(rows.map(([r]) => [r.relativePath, r.codec]));
  };

  it('stores a PGS sidecar as an image codec and a text one without codec', async () => {
    expect(await saved('movie.en.sup', 'movie.fr.srt')).toEqual({
      'movie.en.sup': 'hdmv_pgs_subtitle',
      'movie.fr.srt': null,
    });
  });

  it('stores a .sub next to its .idx as VobSub', async () => {
    expect(await saved('movie.en.sub', 'movie.en.idx')).toEqual({
      'movie.en.sub': 'dvd_subtitle',
    });
  });

  it('skips formats nothing can render: lone .sub, .mks, .smi', async () => {
    expect(await saved('movie.en.sub', 'movie.fr.mks', 'movie.de.smi')).toEqual(
      {},
    );
  });
});
