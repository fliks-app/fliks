import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopEngine } from './desktop-engine';
import type { DesktopEvent, DesktopSubtitleTrack } from '../../plugins/desktop-player.bridge';

const SRV = 'https://srv/api/streaming';
const url = (id: number) => `${SRV}/media/1/subtitles/${id}?token=t`;
const downloaded = (id: number) => `${SRV}/media/1/subtitles/${id}/download?token=t`;

let nextId = 0;
const embedded = (over: Partial<DesktopSubtitleTrack> = {}): DesktopSubtitleTrack => ({
  id: String(++nextId),
  language: 'fre',
  label: '',
  forced: false,
  selected: false,
  image: false,
  external: false,
  source: null,
  ffIndex: null,
  ...over,
});
const sidecar = (id: number, over: Partial<DesktopSubtitleTrack> = {}) =>
  embedded({ language: 'fr', external: true, source: downloaded(id), ...over });

interface Bridge {
  load: ReturnType<typeof vi.fn>;
  subAdd: ReturnType<typeof vi.fn>;
  getSubtitleTracks: ReturnType<typeof vi.fn>;
  selectSubtitleTrack: ReturnType<typeof vi.fn>;
  selectAudioTrack: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emit: (event: DesktopEvent) => void;
}

function installBridge(): Bridge {
  let handler: (event: DesktopEvent) => void = () => {};
  const ok = () => vi.fn(() => Promise.resolve());
  const bridge: Bridge = {
    load: ok(),
    subAdd: ok(),
    getSubtitleTracks: vi.fn(() => Promise.resolve([] as DesktopSubtitleTrack[])),
    selectSubtitleTrack: ok(),
    selectAudioTrack: ok(),
    stop: ok(),
    emit: (e) => handler(e),
  };
  (window as any).fliksDesktop = {
    ...bridge,
    setSubtitleStyle: ok(),
    setFillScreen: ok(),
    on: (h: (event: DesktopEvent) => void) => {
      handler = h;
      return () => {};
    },
  };
  return bridge;
}

describe('DesktopEngine subtitle selection', () => {
  let bridge: Bridge;
  let engine: DesktopEngine;

  const tracksChanged = (subtitleTracks: DesktopSubtitleTrack[], audioTracks = []) =>
    bridge.emit({ type: 'tracksChanged', payload: { audioTracks, subtitleTracks } });
  /** The id the engine last told mpv to select (null = off). */
  const lastSelected = () => bridge.selectSubtitleTrack.mock.lastCall?.[0];

  beforeEach(async () => {
    nextId = 0;
    bridge = installBridge();
    engine = new DesktopEngine();
    await engine.init(document.createElement('div'));
  });

  afterEach(() => {
    delete (window as any).fliksDesktop;
  });

  /** Mimics the player: add the sidecar, then select its handle. */
  async function pick(
    sub: { id: number; language?: string; forced?: boolean; index?: number },
    list: DesktopSubtitleTrack[],
  ) {
    bridge.getSubtitleTracks.mockResolvedValue(list);
    const handle = await engine.addTextTrack(
      url(sub.id),
      sub.language ?? 'fr',
      '',
      sub.forced ?? false,
      sub.index ?? 0,
    );
    engine.selectTextTrack({ ...handle, embIndex: null, image: false });
  }

  it('picks the sidecar it added, not the first track of the same language', async () => {
    const full = sidecar(1);
    const sdh = sidecar(2);
    await pick({ id: 2 }, [full, sdh]);
    expect(lastSelected()).toBe(sdh.id);
    expect(bridge.subAdd).toHaveBeenCalledWith(downloaded(2), '', 'fr');
  });

  it('keeps that pick when mpv later reports an unchanged track list', async () => {
    const full = sidecar(1);
    const sdh = sidecar(2);
    await pick({ id: 2 }, [full, sdh]);
    tracksChanged([full, sdh]);
    expect(lastSelected()).toBe(sdh.id);
  });

  it('prefers an external sidecar over an embedded track of the same language', async () => {
    const container = embedded({ language: 'fre', ffIndex: 3 });
    const srt = sidecar(7);
    await pick({ id: 7, language: 'fr' }, [container, srt]);
    expect(lastSelected()).toBe(srt.id);
  });

  it('keeps an external forced sub forced', async () => {
    const full = sidecar(1);
    const forced = sidecar(2, { forced: true });
    await pick({ id: 2, forced: true }, [full, forced]);
    expect(lastSelected()).toBe(forced.id);
  });

  it('matches an embedded pick by container stream index, not list position', async () => {
    const first = embedded({ language: 'eng', ffIndex: 2 });
    const second = embedded({ language: 'und', ffIndex: 5 });
    tracksChanged([first, second]);
    engine.selectTextTrack({ language: 'fr', forced: false, embIndex: 5, image: false });
    expect(lastSelected()).toBe(second.id);
  });

  it('selects an image subtitle by stream index', () => {
    const text = embedded({ language: 'en', ffIndex: 2 });
    const pgs = embedded({ language: 'en', ffIndex: 4, image: true });
    tracksChanged([text, pgs]);
    engine.selectTextTrack({ language: 'en', forced: false, embIndex: 4, image: true });
    expect(lastSelected()).toBe(pgs.id);
  });

  it('uses the ordinal for a pick with no other identity, within image-ness', () => {
    const text = embedded({ language: 'en' });
    const pgsA = embedded({ language: 'en', image: true });
    const pgsB = embedded({ language: 'en', image: true });
    tracksChanged([text, pgsA, pgsB]);
    engine.selectTextTrack({ language: 'en', forced: false, index: 1, image: true });
    expect(lastSelected()).toBe(pgsB.id);
  });

  it('never shows another language when the pick cannot be resolved', () => {
    tracksChanged([embedded({ language: 'eng', ffIndex: 1 })]);
    engine.selectTextTrack({ language: 'fr', forced: false, image: false });
    expect(lastSelected()).toBeNull();
  });

  it('never lands on a sibling when the picked source is gone', async () => {
    const other = sidecar(1);
    await pick({ id: 2 }, [other]);
    expect(lastSelected()).toBeNull();
  });

  it('resolves a pick that arrives before its track', async () => {
    await pick({ id: 2 }, []);
    expect(lastSelected()).toBeNull();
    const added = sidecar(2);
    tracksChanged([added]);
    expect(lastSelected()).toBe(added.id);
  });

  it('asserts subtitles off when nothing is desired and the new track list arrives', () => {
    const auto = embedded({ selected: true });
    tracksChanged([auto]);
    expect(lastSelected()).toBeNull();
  });

  it('turning subtitles off clears the pick so a later list does not revive it', async () => {
    const sdh = sidecar(2);
    await pick({ id: 2 }, [sdh]);
    engine.setTextVisibility(false);
    tracksChanged([sdh]);
    expect(lastSelected()).toBeNull();
  });

  it('does not carry the previous item track list into the next load', async () => {
    const old = sidecar(2);
    await pick({ id: 2 }, [old]);
    await engine.load('https://srv/next.m3u8');
    bridge.selectSubtitleTrack.mockClear();
    engine.selectTextTrack({ language: 'fr', forced: false, image: false });
    expect(lastSelected()).toBeNull();
  });

  it('shows nothing of the previous pick on the next item', async () => {
    const old = sidecar(2);
    await pick({ id: 2 }, [old]);
    await engine.load('https://srv/next.m3u8');
    tracksChanged([embedded({ language: 'fre', ffIndex: 1, selected: true })]);
    expect(lastSelected()).toBeNull();
  });

  it('keeps the new item track list that arrives while load() is pending', async () => {
    const next = sidecar(9);
    bridge.load.mockImplementation(async () => tracksChanged([next]));
    await engine.load('https://srv/next.m3u8');
    bridge.getSubtitleTracks.mockResolvedValue([next]);
    const handle = await engine.addTextTrack(url(9), 'fr', '', false, 0);
    engine.selectTextTrack({ ...handle, embIndex: null, image: false });
    expect(lastSelected()).toBe(next.id);
  });
});

describe('DesktopEngine audio', () => {
  afterEach(() => {
    delete (window as any).fliksDesktop;
  });

  it('passes the preferred language to load and maps audio-<i> back to mpv ids', async () => {
    const bridge = installBridge();
    const engine = new DesktopEngine();
    await engine.init(document.createElement('div'));
    engine.configure({ preferredAudioLanguage: 'fr' });
    await engine.load('https://srv/m.m3u8');
    expect(bridge.load).toHaveBeenCalledWith(expect.objectContaining({ audioLanguage: 'fr' }));

    bridge.emit({
      type: 'tracksChanged',
      payload: {
        audioTracks: [
          { id: '3', language: 'en', label: '', selected: true },
          { id: '4', language: 'fr', label: '', selected: false },
        ],
        subtitleTracks: [],
      },
    });
    await engine.selectAudioTrack('audio-1');
    expect(bridge.selectAudioTrack).toHaveBeenCalledWith('4');
  });
});
