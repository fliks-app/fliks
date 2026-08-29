import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SubtitleStreamService } from './subtitle-stream.service';

type Svc = SubtitleStreamService & {
  assertExtracted(tmpPath: string): Promise<void>;
};

const svc = new SubtitleStreamService(
  null as never,
  null as never,
  null as never,
  null as never,
  null as never,
) as Svc;

describe('subtitle extraction guards', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-guard-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, body: string) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, body);
    return p;
  };

  it('refuses a zero-byte output — ffmpeg can exit 0 having written nothing', async () => {
    const p = await write('empty.vtt', '');
    await expect(svc.assertExtracted(p)).rejects.toThrow('empty subtitle file');
  });

  it('accepts a cue-less track: no cues is legitimate, the header is still there', async () => {
    // A forced-subtitle track on a dubbed release really can have no cues.
    // Rejecting it would re-extract the whole container on every request.
    const p = await write('header-only.vtt', 'WEBVTT\n\n');
    await expect(svc.assertExtracted(p)).resolves.toBeUndefined();
  });

  it('propagates a missing file rather than promoting it', async () => {
    await expect(
      svc.assertExtracted(path.join(dir, 'nope.vtt')),
    ).rejects.toThrow(/ENOENT/);
  });
});
