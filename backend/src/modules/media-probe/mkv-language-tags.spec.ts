import { execFile } from 'child_process';
import {
  applyMkvLanguageTags,
  parseMkvLanguageTags,
  readMkvLanguageTags,
  resetMkvmergeAvailability,
} from './mkv-language-tags';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
const execFileMock = execFile as unknown as jest.Mock;

type Cb = (err: unknown, res?: { stdout: string }) => void;

const track = (id: number, type: string, ietf?: string) => ({
  id,
  type,
  properties: { language: 'spa', ...(ietf ? { language_ietf: ietf } : {}) },
});
const json = (...tracks: unknown[]) => JSON.stringify({ tracks });

describe('parseMkvLanguageTags', () => {
  it('keeps a region or script, drops a bare language', () => {
    const tags = parseMkvLanguageTags(
      json(
        track(10, 'subtitles', 'es-419'),
        track(11, 'subtitles', 'es-ES'),
        track(12, 'subtitles', 'es'),
        track(13, 'audio', 'und'),
        track(14, 'audio', 'zh-Hant'),
        track(15, 'subtitles'),
      ),
    );
    expect([...tags]).toEqual([
      [10, { type: 'subtitle', tag: 'es-419' }],
      [11, { type: 'subtitle', tag: 'es-ES' }],
      [14, { type: 'audio', tag: 'zh-Hant' }],
    ]);
  });

  it('ignores video tracks and malformed output', () => {
    expect(parseMkvLanguageTags(json(track(0, 'video', 'pt-BR'))).size).toBe(0);
    expect(parseMkvLanguageTags('not json').size).toBe(0);
    expect(parseMkvLanguageTags('{"tracks":{}}').size).toBe(0);
  });
});

describe('applyMkvLanguageTags', () => {
  it('tags by id and ignores a type mismatch', () => {
    const tags = parseMkvLanguageTags(
      json(track(1, 'audio', 'pt-BR'), track(2, 'subtitles', 'es-419')),
    );
    const audio = [{ streamIndex: 1 }, { streamIndex: 2 }] as {
      streamIndex: number;
      languageTag?: string;
    }[];
    const subs = [{ streamIndex: 1 }, { streamIndex: 2 }] as {
      streamIndex: number;
      languageTag?: string;
    }[];
    applyMkvLanguageTags(tags, audio, subs);
    expect(audio.map((a) => a.languageTag)).toEqual(['pt-BR', undefined]);
    expect(subs.map((s) => s.languageTag)).toEqual([undefined, 'es-419']);
  });
});

describe('readMkvLanguageTags', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    resetMkvmergeAvailability();
  });

  it('returns the parsed tags', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb: Cb) =>
      cb(null, { stdout: json(track(3, 'subtitles', 'pt-PT')) }),
    );
    expect((await readMkvLanguageTags('/a.mkv')).get(3)?.tag).toBe('pt-PT');
  });

  it('yields no tags and stops spawning once mkvmerge is missing', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb: Cb) =>
      cb(Object.assign(new Error('spawn mkvmerge ENOENT'), { code: 'ENOENT' })),
    );
    expect((await readMkvLanguageTags('/a.mkv')).size).toBe(0);
    expect((await readMkvLanguageTags('/b.mkv')).size).toBe(0);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('degrades on a timeout without caching it as missing', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb: Cb) =>
      cb(Object.assign(new Error('Command failed'), { killed: true })),
    );
    expect((await readMkvLanguageTags('/a.mkv')).size).toBe(0);
    await readMkvLanguageTags('/b.mkv');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the JSON mkvmerge prints alongside a warning exit code', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb: Cb) =>
      cb(
        Object.assign(new Error('exit 1'), {
          stdout: json(track(4, 'audio', 'zh-Hans')),
        }),
      ),
    );
    expect((await readMkvLanguageTags('/a.mkv')).get(4)?.tag).toBe('zh-Hans');
  });
});
