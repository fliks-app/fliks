import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** `cacheDirFor`/`cachePathFor` are private, so intersecting them with the
 *  class collapses to `never` — name them alone and cast through `unknown`. */
type Svc = {
  cacheDirFor(mediaFileId: number): string;
  cachePathFor(mediaFileId: number, streamIndex: number): string;
};

describe('subtitle cache path', () => {
  const OLD_ENV = process.env;
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-cache-path-'));
  });
  afterAll(async () => {
    process.env = OLD_ENV;
    await fs.rm(dir, { recursive: true, force: true });
  });

  function loadSvc(): Svc {
    jest.resetModules();
    process.env = { ...OLD_ENV, FLIKS_DATA_DIR: dir };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SubtitleStreamService } = require('./subtitle-stream.service');
    return new SubtitleStreamService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    ) as unknown as Svc;
  }

  it('resolves under the images volume, not the media folder', () => {
    const svc = loadSvc();
    expect(svc.cachePathFor(7, 2)).toBe(
      path.join(dir, 'subs', '7', 'emb-2.vtt'),
    );
  });

  it('never contains a `.cache` segment', () => {
    const svc = loadSvc();
    expect(svc.cachePathFor(7, 2).split(path.sep)).not.toContain('.cache');
  });

  it('cacheDirFor is the dirname of cachePathFor, as clearMediaFileSubtitleCache assumes', () => {
    const svc = loadSvc();
    expect(svc.cacheDirFor(7)).toBe(path.dirname(svc.cachePathFor(7, 2)));
  });
});
