import { afterEach, vi } from 'vitest';
import { detectHdrTransfers, undecodableVideoMimes } from './media-capabilities';

const stub = (decodingInfo: unknown) => vi.stubGlobal('navigator', { mediaCapabilities: { decodingInfo } });

describe('undecodableVideoMimes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('collects what decodingInfo refuses and ignores a type it throws on', async () => {
    stub(async ({ video }: { video: { contentType: string } }) => {
      if (video.contentType.includes('hvc1')) return { supported: false };
      if (video.contentType.includes('av01')) throw new TypeError('unknown');
      return { supported: true };
    });
    const denied = await undecodableVideoMimes(['video/mp4; codecs="hvc1.1"', 'video/mp4; codecs="av01.0"', 'video/mp4; codecs="avc1.4d"']);
    expect([...denied]).toEqual(['video/mp4; codecs="hvc1.1"']);
  });

  it('is empty where the API is missing', async () => {
    vi.stubGlobal('navigator', {});
    expect((await undecodableVideoMimes(['video/mp4; codecs="hvc1.1"'])).size).toBe(0);
  });
});

describe('detectHdrTransfers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks PQ and HLG separately', async () => {
    stub(async ({ video }: { video: { transferFunction: string } }) => ({ supported: video.transferFunction === 'pq' }));
    expect(await detectHdrTransfers()).toEqual({ pq: true, hlg: false });
  });

  it('is null where the API is missing or rejects every query', async () => {
    vi.stubGlobal('navigator', {});
    expect(await detectHdrTransfers()).toBeNull();
    stub(async () => {
      throw new TypeError('transferFunction unknown');
    });
    expect(await detectHdrTransfers()).toBeNull();
  });

  it('accepts a decode through a later codec when the first refuses', async () => {
    stub(async ({ video }: { video: { contentType: string } }) => ({ supported: video.contentType.includes('vp09') }));
    expect(await detectHdrTransfers()).toEqual({ pq: true, hlg: true });
  });
});
