/* Mixer of the receiver: 16-bit PCM sources summed at their gains, framed as uncompressed FLAC in fragmented MP4
   so the one media element plays the mix through MSE (a Cast device runs one media element, and its Web Audio
   output does not keep real time). */
(function (root) {
  'use strict';

  /** Samples per channel in a FLAC frame, which is one MP4 sample. */
  const BLOCK = 4096;
  const RATE_CODES = { 44100: 0b1001, 48000: 0b1010 };

  function crcTable(bits, poly) {
    const table = new Uint16Array(256);
    const top = 1 << (bits - 1);
    const mask = (1 << bits) - 1;
    for (let i = 0; i < 256; i++) {
      let c = i << (bits - 8);
      for (let k = 0; k < 8; k++) c = (c & top ? (c << 1) ^ poly : c << 1) & mask;
      table[i] = c;
    }
    return table;
  }
  const CRC8 = crcTable(8, 0x07);
  const CRC16 = crcTable(16, 0x8005);

  /** `sources` (interleaved, same length) summed at `gains`, clipped to 16 bits. */
  function mix(sources, gains) {
    const out = new Int16Array(sources[0].length);
    for (let i = 0; i < out.length; i++) {
      let v = 0;
      for (let s = 0; s < sources.length; s++) v += sources[s][i] * gains[s];
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return out;
  }

  /** The UTF-8-style coded number of a FLAC frame header (up to 36 bits, past bitwise range). */
  function codedNumber(v) {
    if (v < 0x80) return [v];
    const tail = [];
    let marker = 0xc0;
    let room = 0x1f;
    for (;;) {
      tail.unshift(0x80 | (v % 64));
      v = Math.floor(v / 64);
      if (v <= room) return [marker | v, ...tail];
      marker = 0x80 | (marker >> 1);
      room >>= 1;
    }
  }

  /** One FLAC frame of `pcm` (interleaved `channels`), VERBATIM subframes, headed by its first sample's number. */
  function flacFrame(pcm, channels, rate, sample) {
    const size = pcm.length / channels;
    const head = [0xff, 0xf9, (0b0111 << 4) | (RATE_CODES[rate] || 0), ((channels - 1) << 4) | (0b100 << 1)];
    head.push(...codedNumber(sample), (size - 1) >> 8, (size - 1) & 0xff);
    const out = new Uint8Array(head.length + 1 + channels * (1 + 2 * size) + 2);
    out.set(head);
    let p = head.length;
    let crc = 0;
    for (let i = 0; i < p; i++) crc = CRC8[crc ^ out[i]];
    out[p++] = crc;
    for (let c = 0; c < channels; c++) {
      out[p++] = 0x02;
      for (let i = c; i < pcm.length; i += channels) {
        out[p++] = pcm[i] >> 8;
        out[p++] = pcm[i];
      }
    }
    crc = 0;
    for (let i = 0; i < p; i++) crc = ((crc << 8) ^ CRC16[(crc >> 8) ^ out[i]]) & 0xffff;
    out[p++] = crc >> 8;
    out[p] = crc;
    return out;
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Big-endian fields: [value, byteLength] pairs and byte arrays. */
  function fields(...items) {
    return concat(items.map((it) => {
      if (!Array.isArray(it)) return it;
      const [v, n] = it;
      const b = new Uint8Array(n);
      for (let i = n - 1, x = v; i >= 0; i--, x = Math.floor(x / 256)) b[i] = x % 256;
      return b;
    }));
  }

  function box(type, ...parts) {
    const body = concat(parts);
    return fields([body.length + 8, 4], new TextEncoder().encode(type), body);
  }

  const full = (type, flags, ...parts) => box(type, fields([flags, 4]), ...parts);
  const zeros = (n) => new Uint8Array(n);
  const MATRIX = fields([0x10000, 4], [0, 4], [0, 4], [0, 4], [0x10000, 4], [0, 4], [0, 4], [0, 4], [0x40000000, 4]);

  /** The init segment of a FLAC track at `rate` Hz on `channels` 16-bit channels. */
  function initSegment(rate, channels) {
    // Block sizes, frame sizes (unknown), then 20-bit rate, channels - 1, bits - 1, 36-bit length (unknown), MD5.
    const streamInfo = fields([16, 2], [BLOCK, 2], [0, 3], [0, 3], [rate * 4096 + (channels - 1) * 512 + 15 * 16, 4], [0, 4], zeros(16));
    const dfLa = full('dfLa', 0, fields([0x80, 1], [34, 3]), streamInfo);
    const entry = box('fLaC', zeros(6), fields([1, 2]), zeros(8), fields([channels, 2], [16, 2], [0, 4], [rate * 65536, 4]), dfLa);
    const stbl = box('stbl',
      full('stsd', 0, fields([1, 4]), entry),
      full('stts', 0, fields([0, 4])),
      full('stsc', 0, fields([0, 4])),
      full('stsz', 0, fields([0, 4], [0, 4])),
      full('stco', 0, fields([0, 4])));
    const minf = box('minf', full('smhd', 0, zeros(4)), box('dinf', full('dref', 0, fields([1, 4]), full('url ', 1))), stbl);
    const mdia = box('mdia',
      full('mdhd', 0, zeros(8), fields([rate, 4], [0, 4], [0x55c4, 2], [0, 2])),
      full('hdlr', 0, zeros(4), new TextEncoder().encode('soun'), zeros(12), new TextEncoder().encode('Fliks\0')),
      minf);
    const trak = box('trak', full('tkhd', 3, zeros(8), fields([1, 4]), zeros(16), fields([0, 2], [0, 2], [0x100, 2], [0, 2]), MATRIX, zeros(8)), mdia);
    const moov = box('moov',
      full('mvhd', 0, zeros(8), fields([rate, 4], [0, 4], [0x10000, 4], [0x100, 2]), zeros(10), MATRIX, zeros(24), fields([2, 4])),
      trak,
      box('mvex', full('trex', 0, fields([1, 4], [1, 4], [0, 4], [0, 4], [0, 4]))));
    return concat([box('ftyp', new TextEncoder().encode('iso6'), fields([0, 4]), new TextEncoder().encode('iso6mp41')), moov]);
  }

  /** A fragment of FLAC `frames` of `durations` samples, the first starting at sample `start`. */
  function mediaSegment(sequence, start, frames, durations) {
    const trun = (offset) => full('trun', 0x301, fields([frames.length, 4], [offset, 4]),
      ...frames.map((f, i) => fields([durations[i], 4], [f.length, 4])));
    const traf = (offset) => box('traf', full('tfhd', 0x20000, fields([1, 4])), box('tfdt', fields([1 << 24, 4], [start, 8])), trun(offset));
    const moof = (offset) => box('moof', full('mfhd', 0, fields([sequence, 4])), traf(offset));
    const size = moof(0).length;
    return concat([moof(size + 8), box('mdat', ...frames)]);
  }

  const api = { BLOCK, mix, flacFrame, initSegment, mediaSegment };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FliksMixer = api;
})(typeof self !== 'undefined' ? self : this);
