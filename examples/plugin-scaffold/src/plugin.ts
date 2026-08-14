import { connect, type Socket } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PluginApi, PluginManifest } from '@fliks/plugin-contract';
// Runtime values come from the leaf, not the barrel: the barrel re-exports the one helper that
// needs semver, and a bundler cannot drop a CJS dependency it has already been asked to evaluate.
import { MAX_FRAME_BYTES, type Req, type Res } from '@fliks/plugin-contract/protocol';

const env = process.env;
const manifest = JSON.parse(readFileSync(join(__dirname, 'plugin.json'), 'utf8')) as PluginManifest;

/** Newline-delimited JSON, one object per line. Core listens on both sockets; this dials them. */
function dial(path: string, onFrame: (sock: Socket, frame: Req) => void): Socket {
  const sock = connect(path);
  let buffered = '';
  sock.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let cut: number;
    while ((cut = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      if (line.length === 0) continue;
      try {
        onFrame(sock, JSON.parse(line) as Req);
      } catch {
        // A frame core sent that this plugin cannot parse: skip it, stay up for the next one.
      }
    }
  });
  sock.on('error', (err) => process.stderr.write(`socket ${path}: ${err.message}\n`));
  return sock;
}

function reply(sock: Socket, res: Res): void {
  const line = `${JSON.stringify(res)}\n`;
  // Core SIGKILLs on an oversize frame, so refuse to be the one that sends it.
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
    reply(sock, { i: res.i, e: { c: 'RESPONSE_TOO_LARGE', m: 'reply exceeded the frame limit' } });
    return;
  }
  sock.write(line);
}

/** The uplink. Requests core's host methods; ids must be unique per connection. */
const core = dial(env.FLIKS_CORE_SOCK!, (_sock, frame) => {
  const settle = pending.get((frame as unknown as Res).i);
  if (!settle) return;
  pending.delete((frame as unknown as Res).i);
  settle(frame as unknown as Res);
});

const pending = new Map<number, (res: Res) => void>();
let nextId = 1;

export function callHost<T>(method: string, params?: unknown): Promise<T> {
  const i = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(i, (res) => (res.e ? reject(new Error(`${res.e.c}: ${res.e.m}`)) : resolve(res.r as T)));
    core.write(`${JSON.stringify({ i, m: method, p: params } satisfies Req)}\n`);
  });
}

/**
 * The 7 methods core calls. `event` and `config` are notes — replying to one is a protocol
 * violation. Everything else must answer, and within the deadline core publishes for it.
 */
const api: PluginApi = {
  hello: async () => ({ manifest, token: env.FLIKS_PLUGIN_TOKEN ?? '' }),

  health: async () => ({ ok: true }),

  job: async ({ name }) => {
    // stderr is this plugin's log: core tags each line with the plugin id and buffers it.
    const config = await callHost<Record<string, string>>('config.get', {});
    process.stderr.write(`job ${name} ran with ${Object.keys(config).length} setting(s)\n`);
    return { ok: true };
  },

  http: async ({ method, path }) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { hello: `${method} ${path}` },
  }),

  event: () => {},

  config: () => {},

  shutdown: async () => {
    setTimeout(() => process.exit(0), 10);
    return { ok: true };
  },
};

dial(env.FLIKS_PLUGIN_SOCK!, (sock, req) => {
  const handler = api[req.m as keyof PluginApi] as ((p: unknown) => unknown) | undefined;
  if (!handler) {
    reply(sock, { i: req.i, e: { c: 'UNKNOWN_METHOD', m: req.m } });
    return;
  }
  // A note carries no `i`; core sends no reply for it and accepts none.
  if (req.i === undefined) {
    handler(req.p);
    return;
  }
  Promise.resolve(handler(req.p)).then(
    (r) => reply(sock, { i: req.i, r }),
    (err: Error) => reply(sock, { i: req.i, e: { c: 'PLUGIN_ERROR', m: err.message } }),
  );
});
