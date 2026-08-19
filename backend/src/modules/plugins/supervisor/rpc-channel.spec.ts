import { createServer, connect, type Server, type Socket } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_FRAME_BYTES } from '../../../common/plugin-contract';
import { RpcChannel } from './rpc-channel';
import { RpcTimeoutError } from './wire';

interface Pair {
  srv: Server;
  server: RpcChannel;
  client: RpcChannel;
  clientSocket: Socket;
  dir: string;
}

/** Real unix sockets both ends — RpcChannel is the transport under test, never mocked. */
function makePair(): Promise<Pair> {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-channel-'));
  const sockPath = join(dir, 'a.sock');
  return new Promise((resolve, reject) => {
    const srv: Server = createServer((socket: Socket) => {
      resolve({ srv, server: new RpcChannel(socket), client, clientSocket, dir });
    });
    let client: RpcChannel;
    let clientSocket: Socket;
    srv.once('error', reject);
    srv.listen(sockPath, () => {
      clientSocket = connect(sockPath);
      client = new RpcChannel(clientSocket);
    });
  });
}

/** Closes both channels and the listening server so no socket or handle survives the test. */
function teardown(pair: Pair): void {
  pair.server.destroy();
  pair.client.destroy();
  pair.srv.close();
  rmSync(pair.dir, { recursive: true, force: true });
}

describe('RpcChannel', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('round-trips a call and its response', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    pair.server.onRequest(async (method, payload) => {
      expect(method).toBe('health');
      return { ok: true, echoed: payload };
    });
    const res = await pair.client.call<{ ok: boolean; echoed: unknown }>('health', { x: 1 }, 1_000);
    expect(res).toEqual({ ok: true, echoed: { x: 1 } });
  });

  it('rejects with a timeout when nothing answers', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    await expect(pair.client.call('health', {}, 30)).rejects.toThrow(RpcTimeoutError);
  });

  it('delivers a fire-and-forget note with no reply expected', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    const received = new Promise((resolve) => pair.server.onNote(resolve));
    pair.client.sendNote({ m: 'event', p: { hello: 'world' } });
    await expect(received).resolves.toEqual({ m: 'event', p: { hello: 'world' } });
  });

  it('reports a protocol violation for a malformed line without throwing out of the process', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    const violation = new Promise<Error>((resolve) => pair.server.onViolation(resolve));
    // bypass the channel's own encoder to write a raw malformed line
    pair.clientSocket.write('not json at all\n');
    const err = await violation;
    expect(err.message).toMatch(/malformed/);
  });

  it('rejects pending calls when the connection closes', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    const pending = pair.client.call('health', {}, 5_000);
    pair.server.destroy();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('rejects a locally oversize request without writing it to the wire', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    let received = false;
    pair.server.onRequest(async () => {
      received = true;
      return {};
    });
    const huge = 'a'.repeat(MAX_FRAME_BYTES);
    await expect(pair.client.call('big', huge, 1_000)).rejects.toThrow(/exceeds the \d+ byte limit/);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(false);
  });

  it('answers an oversize result with an error frame, and the channel stays open', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    const huge = 'a'.repeat(MAX_FRAME_BYTES);
    pair.server.onRequest(async () => ({ blob: huge }));
    await expect(pair.client.call('big', {}, 1_000)).rejects.toThrow(/^ERR_RESULT_TOO_LARGE: /);

    pair.server.onRequest(async () => ({ ok: true }));
    await expect(pair.client.call('small', {}, 1_000)).resolves.toEqual({ ok: true });
  });

  it('reports an oversize note to the drop handler instead of throwing', async () => {
    const pair = await makePair();
    cleanup = () => teardown(pair);
    const dropped: string[] = [];
    pair.client.onNoteDropped((note) => dropped.push(note.m));
    let noteReceived = false;
    pair.server.onNote(() => {
      noteReceived = true;
    });

    const huge = 'a'.repeat(MAX_FRAME_BYTES);
    expect(() => pair.client.sendNote({ m: 'huge', p: huge })).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(noteReceived).toBe(false);
    expect(dropped).toEqual(['huge']);

    const received = new Promise((resolve) => pair.server.onNote(resolve));
    pair.client.sendNote({ m: 'small', p: {} });
    await expect(received).resolves.toEqual({ m: 'small', p: {} });
  });

  describe('error frame codes', () => {
    // Each message mirrors an exact throw site in fliks-host.service.ts,
    // plugin-host-binding.service.ts or plugin-supervisor.ts, pinned by those files' own specs.
    const cases: [string, () => Error, string][] = [
      ['unknown host method', () => new Error('unknown host method "media.resolve"'), 'ERR_NO_METHOD'],
      ['host-side deadline', () => new Error('host method "library.ingest" timed out after 30000ms'), 'ERR_TIMEOUT'],
      ['registration gone', () => new Error('plugin "some-plugin" has no active registration'), 'ERR_NOT_FOUND'],
      [
        'ingest path missing on disk',
        () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
        'ERR_NOT_FOUND',
      ],
      [
        'no ingest roots configured',
        () => new Error('library.ingest: no ingestRoots configured for plugin "some-plugin"'),
        'ERR_DENIED',
      ],
      [
        'path outside every ingest root',
        () => new Error('library.ingest: "/tmp/x" is outside every configured ingest root'),
        'ERR_DENIED',
      ],
      [
        'plugin missing a required scope',
        () => new Error('plugin "some-plugin" is missing scope "ingest:write" required for "library.ingest"'),
        'ERR_DENIED',
      ],
      ['payload over its documented limit', () => new Error('media.resolve: 150 ids exceeds the 100 limit'), 'ERR_VALIDATION'],
      ['anything else', () => new Error('some completely unrelated failure'), 'ERR'],
    ];

    for (const [label, buildError, expectedCode] of cases) {
      it(`classifies ${label} as ${expectedCode}`, async () => {
        const pair = await makePair();
        cleanup = () => teardown(pair);
        pair.server.onRequest(async () => {
          throw buildError();
        });
        await expect(pair.client.call('some.method', {}, 1_000)).rejects.toThrow(
          new RegExp(`^${expectedCode}: `),
        );
      });
    }
  });
});
