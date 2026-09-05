import assert from 'node:assert/strict';
import test from 'node:test';
import { absorb, buildQuery, collect, parseRecords, parseTxt } from './mdns.ts';
import { decodeMessage, encodeFrame, splitFrames } from './protocol.ts';
import { mediaStatusEvent, mergeActiveTracks, pickAudioTrack } from './status.ts';

test('CastMessage survives an encode/decode round trip', () => {
  const msg = {
    sourceId: 'sender-abc',
    destinationId: 'receiver-0',
    namespace: 'urn:x-cast:com.google.cast.receiver',
    data: JSON.stringify({ type: 'LAUNCH', appId: '66BF4DAE', requestId: 2 }),
  };
  const { messages, rest } = splitFrames(encodeFrame(msg));
  assert.equal(rest.length, 0);
  assert.equal(messages.length, 1);
  assert.deepEqual(decodeMessage(messages[0]), msg);
});

test('splitFrames keeps a partial frame for the next chunk', () => {
  const a = encodeFrame({ sourceId: 's', destinationId: 'd', namespace: 'n', data: '{"a":1}' });
  const b = encodeFrame({ sourceId: 's', destinationId: 'd', namespace: 'n', data: '{"b":2}' });
  const stream = Buffer.concat([a, b]);
  const cut = stream.subarray(0, a.length + 3);
  const first = splitFrames(cut);
  assert.equal(first.messages.length, 1);
  assert.equal(first.rest.length, 3);

  const second = splitFrames(Buffer.concat([first.rest, stream.subarray(cut.length)]));
  assert.equal(second.messages.length, 1);
  assert.equal(decodeMessage(second.messages[0]).data, '{"b":2}');
});

test('a payload longer than 127 bytes keeps its multi-byte length prefix', () => {
  const data = JSON.stringify({ blob: 'x'.repeat(500) });
  const { messages } = splitFrames(
    encodeFrame({ sourceId: 's', destinationId: 'd', namespace: 'n', data }),
  );
  assert.equal(decodeMessage(messages[0]).data, data);
});

// ── mDNS ──

/** Assemble a response packet the way a Chromecast answers a PTR query: the
 *  instance and host names appear once and every later reference is a
 *  compression pointer, which is the part worth testing. */
function buildResponse(): Buffer {
  const parts: Buffer[] = [];
  let length = 0;
  const push = (buf: Buffer): number => {
    parts.push(buf);
    length += buf.length;
    return length - buf.length;
  };
  const name = (value: string): Buffer =>
    Buffer.concat([
      ...value.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
      Buffer.from([0]),
    ]);
  const pointer = (offset: number): Buffer => Buffer.from([0xc0 | (offset >> 8), offset & 0xff]);
  const rr = (type: number, rdata: Buffer): Buffer => {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(1, 2);
    head.writeUInt32BE(120, 4);
    head.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([head, rdata]);
  };

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6); // one answer
  header.writeUInt16BE(3, 10); // three additionals
  push(header);

  const serviceOffset = push(name('_googlecast._tcp.local'));
  // PTR rdata is the instance name: one fresh label, then a pointer back.
  const instanceLabel = Buffer.concat([Buffer.from([14]), Buffer.from('Chromecast-abc')]);
  const ptrRdata = Buffer.concat([instanceLabel, pointer(serviceOffset)]);
  const instanceOffset = push(rr(12, ptrRdata)) + 10;

  const srvHead = Buffer.alloc(6);
  srvHead.writeUInt16BE(8009, 4);
  const srvStart = push(pointer(instanceOffset));
  const targetOffset = srvStart + 2 + 10 + srvHead.length;
  push(rr(33, Buffer.concat([srvHead, name('abc.local')])));

  push(pointer(instanceOffset));
  const txt = ['id=uuid-1', 'fn=Salon', 'md=Chromecast Ultra'];
  push(
    rr(
      16,
      Buffer.concat(txt.map((t) => Buffer.concat([Buffer.from([t.length]), Buffer.from(t)]))),
    ),
  );

  push(pointer(targetOffset));
  push(rr(1, Buffer.from([192, 168, 1, 42])));

  return Buffer.concat(parts);
}

test('a Cast announcement resolves to a complete device', () => {
  const services = new Map();
  const addresses = new Map();
  absorb(buildResponse(), services, addresses);
  assert.deepEqual(collect(services, addresses), [
    {
      id: 'uuid-1',
      name: 'Salon',
      modelName: 'Chromecast Ultra',
      host: '192.168.1.42',
      port: 8009,
    },
  ]);
});

test('a foreign mDNS service on the segment is not mistaken for a Cast device', () => {
  const services = new Map();
  const addresses = new Map();
  // The socket sees the whole segment; only what a googlecast PTR introduced counts.
  absorb(buildResponse(), services, addresses);
  const printer = buildResponse();
  printer.write('_printerxx', printer.indexOf('_googlecast'));
  absorb(printer, services, addresses);
  assert.equal(collect(services, addresses).length, 1);
});

test('a device is withheld until its address record lands', () => {
  const services = new Map([['Chromecast-abc._googlecast._tcp.local', { target: 'abc.local', port: 8009 }]]);
  assert.deepEqual(collect(services, new Map()), []);
});

test('the PTR query is a well-formed single question', () => {
  const query = buildQuery();
  assert.equal(query.readUInt16BE(4), 1);
  assert.equal(query.readUInt16BE(6), 0);
  assert.deepEqual(parseRecords(query), []);
  assert.equal(query.readUInt16BE(query.length - 4), 12);
});

test('TXT rdata splits on the first "=" only', () => {
  const entry = 'fn=Salon=TV';
  const buf = Buffer.concat([Buffer.from([entry.length]), Buffer.from(entry)]);
  assert.deepEqual(parseTxt(buf, 0, buf.length), { fn: 'Salon=TV' });
});

// ── receiver status ──

test('a playing status becomes a media update', () => {
  const event = mediaStatusEvent(
    { playerState: 'PLAYING', currentTime: 42.5, volume: { level: 0.6, muted: false } },
    { duration: 3600 },
  );
  assert.deepEqual(event, {
    name: 'castMediaUpdate',
    detail: {
      currentTime: 42.5,
      duration: 3600,
      isPaused: false,
      buffering: false,
      volume: 0.6,
      muted: false,
    },
  });
});

test('IDLE/ERROR becomes a recoverable error carrying the playhead', () => {
  const event = mediaStatusEvent(
    { playerState: 'IDLE', idleReason: 'ERROR', currentTime: 128 },
    { duration: 3600 },
  );
  assert.deepEqual(event, { name: 'castError', detail: { position: 128 } });
});

test('IDLE without an error reason is an ordinary update, not a failure', () => {
  const event = mediaStatusEvent({ playerState: 'IDLE', idleReason: 'FINISHED' }, undefined);
  assert.equal(event.name, 'castMediaUpdate');
});

const TRACKS = [
  { trackId: 1, type: 'TEXT', name: 'French', language: 'fr' },
  { trackId: 2, type: 'TEXT', name: 'English', language: 'en' },
  { trackId: 3, type: 'AUDIO', name: 'VF', language: 'fr' },
  { trackId: 4, type: 'AUDIO', name: 'VO', language: 'en' },
];

test('changing the subtitle keeps the active audio alive', () => {
  assert.deepEqual(mergeActiveTracks(TRACKS, [2, 4], { textId: 1 }), [4, 1]);
});

test('changing the audio keeps the active subtitle alive', () => {
  assert.deepEqual(mergeActiveTracks(TRACKS, [2, 4], { audioId: 3 }), [3, 2]);
});

test('a null id disables that track type and nothing else', () => {
  assert.deepEqual(mergeActiveTracks(TRACKS, [2, 4], { textId: null }), [4]);
});

test('audio matches on name before language, for 3-letter sources', () => {
  // Shaka rewrote the manifest's "fre" to "fr", so only the NAME still matches.
  assert.equal(pickAudioTrack(TRACKS, 'fre', 'VF')?.trackId, 3);
  assert.equal(pickAudioTrack(TRACKS, 'en', 'Nonexistent')?.trackId, 4);
  assert.equal(pickAudioTrack(TRACKS, 'de', 'German'), undefined);
});
