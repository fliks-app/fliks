import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

type Spawned = {
  cmd: string;
  args: string[];
  proc: EventEmitter & { stderr: EventEmitter };
};

/** Writes every `-y` output of a run and exits 0, unless `hang` holds it until aborted. */
function fakeSpawn(spawned: Spawned[], hang: (run: number) => boolean) {
  return jest.fn(
    (cmd: string, args: string[], opts: { signal?: AbortSignal }) => {
      const proc = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
      });
      const run = spawned.push({ cmd, args, proc }) - 1;
      opts.signal?.addEventListener('abort', () => {
        proc.emit('error', opts.signal!.reason);
        proc.emit('close', null, 'SIGTERM');
      });
      if (!hang(run)) {
        const outs = args.filter((_, i) => args[i - 1] === '-y');
        setImmediate(async () => {
          for (const out of outs) await fs.writeFile(out, '[Script Info]\n');
          proc.emit('close', 0, null);
        });
      }
      return proc;
    },
  );
}

const SUBS = [
  { streamIndex: 2, isImageBased: false },
  { streamIndex: 3, isImageBased: false },
];

describe('subtitle extraction priority', () => {
  const OLD_ENV = process.env;
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-priority-'));
  });
  afterEach(async () => {
    process.env = OLD_ENV;
    jest.resetModules();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function load(hang: (run: number) => boolean) {
    jest.resetModules();
    process.env = { ...OLD_ENV, FLIKS_CACHE_DIR: dir };
    const spawned: Spawned[] = [];
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      spawn: fakeSpawn(spawned, hang),
    }));
    const slots =
      require('../../common/utils/ffmpeg-slots') as typeof import('../../common/utils/ffmpeg-slots');
    const { SubtitleStreamService } =
      require('./subtitle-stream.service') as typeof import('./subtitle-stream.service');
    const svc = new SubtitleStreamService(
      null as never,
      { create: (v: unknown) => v, save: async (v: unknown) => v } as never,
      {
        resolveFile: async () => ({
          absolutePath: '/m/s01e01.mkv',
          mediaFile: { streamInfo: { subtitles: SUBS } },
        }),
      } as never,
      { emit: jest.fn() } as never,
      { get: async () => ({ subtitlePrewarm: 'import' }) } as never,
      {
        upsertPending: jest.fn(),
        upsertRunning: jest.fn(),
        remove: jest.fn(),
      } as never,
    );
    const warmupDone = new Promise<void>((resolve) => {
      jest
        .spyOn(
          svc as unknown as { finalizeBatch(): Promise<void> },
          'finalizeBatch',
        )
        .mockImplementation(async () => resolve());
    });
    return { svc, slots, spawned, warmupDone };
  }

  const inflight = async (svc: unknown) => {
    const map = (svc as { inflight: Map<string, unknown> }).inflight;
    while (!map.size) await new Promise((r) => setImmediate(r));
  };

  const within = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('waited behind the background job')),
          1000,
        ),
      ),
    ]);

  it('does not wait for the slot a queued warmup is waiting on', async () => {
    const { svc, slots, spawned, warmupDone } = load(() => false);
    slots.setFfmpegSlots(1);
    let free!: () => void;
    const holder = slots.withFfmpegSlot(
      () => new Promise<void>((r) => (free = r)),
    );

    await svc.warmupCache('/m/s01e01.mkv', 1, SUBS, { title: 'Ep' }, 'import');
    await inflight(svc);
    const stream: { destroy(): void } = await within(
      svc.extractEmbeddedSubtitle(1, 2),
    );
    stream.destroy();

    expect(spawned.map((s) => s.cmd)).toEqual(['ffmpeg']);
    expect(spawned[0].args).toEqual(expect.arrayContaining(['0:2', '0:3']));
    free();
    await holder;
    await within(warmupDone);
    expect(spawned).toHaveLength(1);
  });

  it('replaces a warmup already running at idle priority', async () => {
    const { svc, spawned, warmupDone } = load((run) => run === 0);

    await svc.warmupCache('/m/s01e01.mkv', 1, SUBS, { title: 'Ep' }, 'import');
    await inflight(svc);
    while (!spawned.length) await new Promise((r) => setImmediate(r));
    const stream: { destroy(): void } = await within(
      svc.extractEmbeddedSubtitle(1, 3),
    );
    stream.destroy();

    expect(spawned).toHaveLength(2);
    expect(spawned[1].cmd).toBe('ffmpeg');
    await within(warmupDone);
    for (const idx of [2, 3]) {
      await expect(
        fs.readFile(path.join(dir, 'subs', '1', `emb-${idx}.vtt`), 'utf-8'),
      ).resolves.toMatch(/^WEBVTT/);
    }
  });
});
