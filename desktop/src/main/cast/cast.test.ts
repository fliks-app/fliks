import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearRecord, loadRecord, resumeDecision, resumeFromMedia, saveRecord } from './resume.ts';
import { absorb, buildQuery, collect, parseRecords, parseTxt } from './mdns.ts';
import { decodeMessage, encodeFrame, splitFrames } from './protocol.ts';
import { editTracksInfo, initializeResult, mediaStatusEvent, mergeActiveTracks, pickAudioTrack, receiverMessageEvent, receiverStatusEvent } from './status.ts';

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

test('a playing status becomes a media update, without the stream volume', () => {
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
      ended: false,
      interrupted: false,
      customData: {},
    },
  });
});

test('a status forwards only the Fliks ids of the media the receiver plays', () => {
  const media = { duration: 60, customData: { mediaId: 3, mediaFileId: 7, episodeId: 5, sid: 's', edl: [1, 2, 3] } };
  const detail = mediaStatusEvent({ playerState: 'PLAYING' }, media).detail as { customData?: unknown };
  assert.deepEqual(detail.customData, { mediaId: 3, mediaFileId: 7, episodeId: 5, sid: 's' });
  assert.equal((mediaStatusEvent({ playerState: 'PLAYING' }, undefined).detail as { customData?: unknown }).customData, undefined);
});

test('a volume change is a device event that carries no media field', () => {
  const event = receiverStatusEvent({ volume: { level: 0.4, muted: false }, applications: [] });
  assert.deepEqual(event, { name: 'castDeviceUpdate', detail: { volume: 0.4, muted: false } });
  assert.equal(receiverStatusEvent({ applications: [] }), null);
});

test('IDLE/ERROR becomes a recoverable error carrying the playhead', () => {
  const event = mediaStatusEvent(
    { playerState: 'IDLE', idleReason: 'ERROR', currentTime: 128 },
    { duration: 3600 },
  );
  assert.deepEqual(event, { name: 'castError', detail: { position: 128 } });
});

test('IDLE/INTERRUPTED means another sender replaced the media, not an error', () => {
  const event = mediaStatusEvent({ playerState: 'IDLE', idleReason: 'INTERRUPTED', currentTime: 90 }, { duration: 3600 });
  assert.equal(event.name, 'castMediaUpdate');
  const detail = event.detail as { interrupted?: boolean; ended?: boolean };
  assert.equal(detail.interrupted, true);
  assert.equal(detail.ended, false);
});

test('IDLE without an error reason is an ordinary update, not a failure', () => {
  const event = mediaStatusEvent({ playerState: 'IDLE', idleReason: 'FINISHED' }, undefined);
  assert.equal(event.name, 'castMediaUpdate');
  assert.equal((event.detail as { ended?: boolean }).ended, true);
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

test('a style edit keeps the active audio and subtitle', () => {
  const style = { fontGenericFamily: 'SANS_SERIF', fontScale: 1, foregroundColor: '#FFFFFFFF', backgroundColor: '#00000000', edgeType: 'NONE', edgeColor: '#00000000' };
  assert.deepEqual(editTracksInfo(TRACKS, [2, 4], {}, style), {
    type: 'EDIT_TRACKS_INFO',
    activeTrackIds: [4, 2],
    textTrackStyle: style,
  });
  assert.equal('textTrackStyle' in editTracksInfo(TRACKS, [2, 4], { textId: 1 }), false);
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

const TWINS = [
  { trackId: 5, type: 'AUDIO', name: 'en', language: 'en' },
  { trackId: 6, type: 'AUDIO', name: 'en #2', language: 'en' },
];

test('same-language audio is told apart by its unique name', () => {
  assert.equal(pickAudioTrack(TWINS, 'en', 'en #2')?.trackId, 6);
  assert.equal(pickAudioTrack(TWINS, 'en', 'en')?.trackId, 5);
});

test('a regional tag still stands in for its language', () => {
  const tagged = [{ trackId: 7, type: 'AUDIO', name: 'es', language: 'es-419' }];
  assert.equal(pickAudioTrack(tagged, 'es', 'Nonexistent')?.trackId, 7);
});

test('an ambiguous language never stands in for a missing name', () => {
  assert.equal(pickAudioTrack(TWINS, 'en', 'Nonexistent'), undefined);
});

test('a Fliks namespace message is forwarded verbatim, others are not', () => {
  const data = { kind: 'qoe', at: 1, sample: { engine: 'cast' } };
  assert.deepEqual(receiverMessageEvent('urn:x-cast:media.fliks.app', data), {
    name: 'castReceiverMessage',
    detail: { namespace: 'urn:x-cast:media.fliks.app', message: JSON.stringify(data) },
  });
  assert.equal(receiverMessageEvent('urn:x-cast:com.google.cast.media', data), null);
});

test('initializeResult hands the saved state back only while a session is live', () => {
  const state = { mediaFileId: 53 };
  assert.deepEqual(initializeResult(true, true, state), { available: true, connected: true, resume: state });
  assert.equal(initializeResult(true, false, state).resume, undefined);
  assert.deepEqual(initializeResult(true, true, state, { volume: 0.4, muted: false }).device, { volume: 0.4, muted: false });
  assert.equal('device' in initializeResult(true, false, state, { volume: 1 }), false);
  assert.equal(initializeResult(true, true, null).resume, undefined);
});

function loadCues() {
  const ctx: { self: Record<string, any> } = { self: {} };
  vm.runInNewContext(readFileSync(new URL('../../../../cast-receiver/cues.js', import.meta.url), 'utf8'), ctx);
  return ctx.self['FliksCues'] as {
    activeCue(c: unknown, fileId: number, t: number): string | null;
    cueText(c: unknown, cue: string, remoteKeys: boolean): string;
    bandGeometry(c: unknown, fileId: number, duration: number): { kind: string; left: number; width: number }[];
  };
}

test('receiver cues: intro, then next episode only when one follows, only for the loaded file', () => {
  const { activeCue } = loadCues();
  const cues = { fileId: 7, intro: { startSeconds: 10, endSeconds: 70 }, outro: { startSeconds: 900, endSeconds: 1000 }, hasNext: true };
  assert.equal(activeCue(cues, 7, 5), null);
  assert.equal(activeCue(cues, 7, 30), 'intro');
  assert.equal(activeCue(cues, 7, 69.5), null);
  assert.equal(activeCue(cues, 7, 950), 'next');
  assert.equal(activeCue({ ...cues, hasNext: false }, 7, 950), null);
  assert.equal(activeCue(cues, 8, 30), null);
  assert.equal(activeCue(null, 7, 30), null);
});

test('receiver cue text is a hint until a remote key has been seen', () => {
  const { cueText } = loadCues();
  const cues = { labels: { intro: 'Skip intro', introHint: 'From your device', next: 'Next', nextHint: 'Next from device' } };
  assert.equal(cueText(cues, 'intro', false), 'From your device');
  assert.equal(cueText(cues, 'intro', true), 'Skip intro');
  assert.equal(cueText(cues, 'next', false), 'Next from device');
  assert.equal(cueText(cues, 'next', true), 'Next');
});

const record = { deviceId: 'd1', host: '10.0.0.5', port: 8009, appId: 'APP', sessionId: 'S1', resume: { mediaFileId: 7, mediaId: 3 } };

test('the session record round-trips through userData and clears', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cast-rec-'));
  try {
    assert.equal(loadRecord(dir), null);
    saveRecord(dir, record);
    assert.deepEqual(loadRecord(dir), record);
    clearRecord(dir);
    assert.equal(loadRecord(dir), null);
    clearRecord(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumeDecision joins only our app with the same session id', () => {
  const app = (appId: string, sessionId: string) => ({ appId, sessionId, transportId: `t-${sessionId}` });
  assert.deepEqual(resumeDecision(record, { applications: [app('APP', 'S1')] }), { transportId: 't-S1' });
  assert.equal(resumeDecision(record, { applications: [app('APP', 'S2')] }), null);
  assert.equal(resumeDecision(record, { applications: [app('OTHER', 'S1')] }), null);
  assert.equal(resumeDecision(record, { applications: [] }), null);
  assert.equal(resumeDecision(record, undefined), null);
});

test('resumeFromMedia keeps the saved state only for the item the receiver still plays', () => {
  const playing = (customData: unknown, playerState = 'PLAYING') => ({ playerState, media: { customData } });
  assert.equal(resumeFromMedia(record.resume, playing({ mediaFileId: 7, mediaId: 3 })), record.resume);
  assert.equal(resumeFromMedia(record.resume, playing({ mediaFileId: 8, mediaId: 3 })), undefined);
  assert.equal(resumeFromMedia(record.resume, playing({ mediaFileId: 7, mediaId: 3 }, 'IDLE')), undefined);
  assert.equal(resumeFromMedia(record.resume, playing(undefined)), undefined);
  assert.equal(resumeFromMedia(record.resume, undefined), undefined);
  assert.equal(resumeFromMedia(undefined, playing({ mediaFileId: 7, mediaId: 3 })), undefined);
});

test('receiver bands: intro and credits as track percentages, clamped, only for the loaded file', () => {
  const { bandGeometry } = loadCues();
  const bands = (...a: Parameters<typeof bandGeometry>) => JSON.parse(JSON.stringify(bandGeometry(...a)));
  const cues = { fileId: 7, intro: { startSeconds: 100, endSeconds: 200 }, outro: { startSeconds: 900, endSeconds: 1200 } };
  assert.deepEqual(bands(cues, 7, 1000), [
    { kind: 'intro', left: 10, width: 10 },
    { kind: 'outro', left: 90, width: 10 },
  ]);
  assert.deepEqual(bands({ fileId: 7, intro: null, outro: null }, 7, 1000), []);
  assert.deepEqual(bands(cues, 8, 1000), []);
  assert.deepEqual(bands(cues, 7, 0), []);
  assert.deepEqual(bands(cues, 7, Infinity), []);
  assert.deepEqual(bands(null, 7, 1000), []);
});
