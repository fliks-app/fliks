import { isManifestContainer, isManifestPayload, parseProbeOutput } from './livetv-session.service';

describe('isManifestPayload', () => {
  it('sees an HLS playlist whatever the content type claims', () => {
    expect(isManifestPayload(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n'))).toBe(true);
  });

  it('sees one behind a byte-order mark and leading whitespace', () => {
    expect(isManifestPayload(Buffer.from('﻿\n  #EXTM3U\n'))).toBe(true);
  });

  it('sees a DASH manifest in both spellings', () => {
    expect(isManifestPayload(Buffer.from('<?xml version="1.0"?>'))).toBe(true);
    expect(isManifestPayload(Buffer.from('<MPD xmlns="urn:mpeg:dash:schema">'))).toBe(true);
  });

  it('lets a transport stream through', () => {
    expect(isManifestPayload(Buffer.from([0x47, 0x40, 0x00, 0x10, 0x00, 0xb0, 0x0d, 0x00]))).toBe(false);
  });
});

describe('parseProbeOutput', () => {
  it('reads the codecs and the container from one probe', () => {
    expect(parseProbeOutput('aac,audio\nh264,video\nhls\n')).toEqual({
      video: 'h264',
      audio: 'aac',
      container: 'hls',
    });
  });

  it('keeps a container whose own name holds commas', () => {
    expect(parseProbeOutput('h264,video\nmov,mp4,m4a,3gp,3g2,mj2\n').container).toBe(
      'mov,mp4,m4a,3gp,3g2,mj2',
    );
  });

  it('takes the first stream of each kind, as a master playlist lists several', () => {
    const out = parseProbeOutput('aac,audio\nh264,video\nac3,audio\nhevc,video\nhls\n');
    expect([out.video, out.audio]).toEqual(['h264', 'aac']);
  });
});

describe('isManifestContainer', () => {
  it('rules out direct play for a playlist container', () => {
    expect(isManifestContainer('hls')).toBe(true);
    expect(isManifestContainer('dash')).toBe(true);
    expect(isManifestContainer('hls,applehttp')).toBe(true);
  });

  it('allows it for a transport stream, and for anything unprobed or unknown', () => {
    expect(isManifestContainer('mpegts')).toBe(false);
    expect(isManifestContainer(null)).toBe(false);
    expect(isManifestContainer('matroska,webm')).toBe(false);
  });
});
