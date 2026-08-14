'use strict';
/**
 * Real test double for a `process` plugin (never shipped): speaks the real
 * protocol over both sockets, with misbehaviour selected via FIXTURE_MODE.
 * ponytail: line-framer duplicated, not imported — this must run as plain node, no build step.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

// Mode travels as a file next to plugin.js: the env allowlist has no room for test-only vars.
let mode = process.env.FIXTURE_MODE || 'good';
try {
  mode = fs.readFileSync(path.join(__dirname, 'FIXTURE_MODE'), 'utf8').trim() || mode;
} catch {
  // no mode file: env var (unsandboxed manual runs) or default 'good'
}
const token = process.env.FLIKS_PLUGIN_TOKEN || '';
const coreSock = process.env.FLIKS_CORE_SOCK;
const pluginSock = process.env.FLIKS_PLUGIN_SOCK;
const FRAME_LIMIT = 4 * 1024 * 1024; // must match MAX_FRAME_BYTES in common/plugin-contract/protocol.ts

function connectLineSocket(path, onLine) {
  const sock = net.connect(path);
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) onLine(sock, line);
    }
  });
  sock.on('error', () => {});
  return sock;
}

function send(sock, obj) {
  sock.write(JSON.stringify(obj) + '\n');
}

if (mode === 'exit-immediately') {
  process.exit(1);
}

if (mode === 'never-connect') {
  // Alive but deliberately never touches either socket — proves the
  // top-level handshake deadline fires even with no connection at all.
  setInterval(() => {}, 60_000);
} else if (mode === 'raw-oversize') {
  const sock = net.connect(pluginSock);
  sock.on('connect', () => sock.write('x'.repeat(FRAME_LIMIT + 1) + '\n'));
  sock.on('error', () => {});
} else if (mode === 'raw-malformed') {
  const sock = net.connect(pluginSock);
  sock.on('connect', () => sock.write('not json\n'));
  sock.on('error', () => {});
} else {
  let healthCount = 0;

  connectLineSocket(coreSock, () => {}); // uplink — nothing calls the 17 core methods in this PR

  connectLineSocket(pluginSock, (sock, line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }

    if (req.m === 'hello') {
      if (mode === 'never-hello') return;
      const replyToken = mode === 'wrong-token' ? 'not-the-token' : token;
      send(sock, { i: req.i, r: { manifest: { id: process.env.FLIKS_PLUGIN_ID }, token: replyToken } });
      if (mode.startsWith('crash-after-ms:')) {
        const ms = Number(mode.split(':')[1]);
        setTimeout(() => process.exit(1), ms);
      }
      if (mode === 'no-read') sock.pause();
      return;
    }

    if (req.m === 'health') {
      healthCount++;
      if (mode.startsWith('health-fail-after:')) {
        const n = Number(mode.split(':')[1]);
        if (healthCount > n) return; // stop answering from here on
      }
      if (mode.startsWith('health-not-ok-after:')) {
        const n = Number(mode.split(':')[1]);
        if (healthCount > n) {
          send(sock, { i: req.i, r: { ok: false, detail: 'fixture unhealthy' } });
          return;
        }
      }
      send(sock, { i: req.i, r: { ok: true } });
      return;
    }

    if (req.m === 'shutdown') {
      if (mode === 'ignore-shutdown') return; // never reply; SIGTERM is also ignored, see below
      send(sock, { i: req.i, r: { ok: true } });
      setTimeout(() => process.exit(0), 5);
      return;
    }

    if (req.m === 'job' || req.m === 'http') {
      send(sock, { i: req.i, r: { ok: true } });
    }
  });

  if (mode === 'ignore-shutdown') {
    process.on('SIGTERM', () => {}); // forces the supervisor down the SIGKILL branch
  }

  if (mode === 'log-levels') {
    process.stderr.write('[2026-01-01T00:00:00.000Z] WARN nothing configured yet\n');
    process.stderr.write('[2026-01-01T00:00:00.000Z] ERROR the driver refused\n');
  }

  if (mode === 'flood-stdout') {
    setInterval(() => {
      for (let i = 0; i < 500; i++) process.stdout.write('x'.repeat(200) + '\n');
    }, 5);
  }
}
