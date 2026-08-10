import { createServer, connect, type Server, type Socket } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RpcChannel } from './rpc-channel';

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
    await expect(pair.client.call('health', {}, 30)).rejects.toThrow(/timeout/);
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
});
