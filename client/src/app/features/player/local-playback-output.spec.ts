import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { LocalPlaybackOutput, type LocalOutputHost } from './local-playback-output';

function setup(selectAudio: (id: string) => Promise<void> = async () => {}) {
  const tracks = [
    { id: 'shaka-7', label: 'en' },
    { id: 'shaka-4', label: 'fr' },
  ];
  const host = { audioTracks: signal(tracks), selectAudio: vi.fn(selectAudio), selectSubtitle: vi.fn(async () => {}), selectQuality: vi.fn(async () => {}) };
  const output = new LocalPlaybackOutput(host as unknown as LocalOutputHost, {} as never);
  return { host, output };
}

describe('LocalPlaybackOutput id-based picks', () => {
  it('maps an audio id to the local track at that index', async () => {
    const { host, output } = setup();
    await output.selectAudioById('audio-1');
    expect(host.selectAudio).toHaveBeenCalledWith('shaka-4');
  });

  it('warns and skips an index with no local track', async () => {
    const { host, output } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await output.selectAudioById('audio-9');
    await output.selectAudioById('nope');
    expect(host.selectAudio).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows a failed audio switch so the command still acknowledges', async () => {
    const { output } = setup(async () => { throw new Error('boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(output.selectAudioById('audio-0')).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('passes subtitle and quality ids through', async () => {
    const { host, output } = setup();
    await output.selectSubtitleById(null);
    await output.selectQualityById('720p');
    expect(host.selectSubtitle).toHaveBeenCalledWith(null);
    expect(host.selectQuality).toHaveBeenCalledWith('720p');
  });
});
