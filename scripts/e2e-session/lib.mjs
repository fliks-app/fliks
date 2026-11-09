// Helpers for run.mjs: CDP over Node's global WebSocket, headless Chromium lifecycle, API client.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value; throws `label` on timeout. */
export async function until(fn, timeoutMs, label, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout (${timeoutMs} ms): ${label}`);
    await sleep(everyMs);
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** i18n lookup in the client's own bundle, so labels never drift from the UI. */
export function loadLabels(lang) {
  const file = new URL(`../../client/public/i18n/${lang}.json`, import.meta.url);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  return (key, vars = {}) => {
    const raw = key.split('.').reduce((o, k) => o?.[k], json);
    if (typeof raw !== 'string') throw new Error(`missing i18n key ${key} in ${lang}.json`);
    return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''));
  };
}

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async connect(wsUrl) {
    const c = new Cdp();
    c.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      c.#ws.onopen = res;
      c.#ws.onerror = () => rej(new Error('CDP websocket error'));
    });
    c.#ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const p = m.id && c.#pending.get(m.id);
      if (!p) return;
      c.#pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
      else p.res(m.result);
    };
    return c;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** One headless Chromium with its own profile and debugging port. */
export class Browser {
  constructor({ name, port, chromium }) {
    this.name = name;
    this.port = port;
    this.chromium = chromium;
    this.profile = `/tmp/fliks-e2e-${process.pid}-${name}`;
    this.proc = null;
    this.cdp = null;
    this.targetId = null;
  }

  async start() {
    // detached: its own process group, killed by PID on stop
    this.proc = spawn(
      this.chromium,
      [
        '--headless=new', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`,
        '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--no-default-browser-check',
        '--window-size=1280,800', 'about:blank',
      ],
      { detached: true, stdio: 'ignore' },
    );
    this.proc.on('error', (e) => console.error(`[${this.name}] spawn failed: ${e.message}`));
    const list = await until(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
      return pages.find((p) => p.type === 'page');
    }, 30_000, `${this.name}: chromium debugging port ${this.port}`, 500);
    this.cdp = await Cdp.connect(list.webSocketDebuggerUrl);
    await this.cdp.send('Page.enable');
    await this.cdp.send('Network.enable');
  }

  eval(expr) {
    return this.cdp.eval(expr);
  }

  /** Crashes the renderer of the tab: no pagehide, no stop beacon, the SSE stream just drops. */
  async crash() {
    this.crashed = true;
    await this.cdp.send('Page.crash').catch(() => undefined);
    this.cdp.close();
    this.cdp = null;
  }

  /** Closes the browser over CDP, then kills its process group by PID if it lingers. */
  async stop() {
    try {
      const v = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
      const c = await Cdp.connect(v.webSocketDebuggerUrl);
      c.send('Browser.close').catch(() => undefined);
      await until(async () => !(await fetch(`http://127.0.0.1:${this.port}/json/version`).then(() => true, () => false)), 15_000, 'browser exit', 300);
      c.close();
    } catch {
      /* already gone */
    }
    this.cdp?.close();
    this.cdp = null;
    const pid = this.proc?.pid;
    if (pid && alive(pid)) {
      try {
        // the snap's confinement refuses signals from outside it, not from its own shell
        execFileSync('snap', ['run', '--shell', 'chromium', '-c', `kill -9 -- -${pid}`], { stdio: 'ignore' });
      } catch {
        /* gone meanwhile */
      }
    }
    this.proc = null;
    this.crashed = false;
  }

  /** Stops the browser and deletes its profile from the snap's private /tmp. */
  async dispose() {
    await this.stop();
    try {
      execFileSync('snap', ['run', '--shell', 'chromium', '-c', `rm -rf ${this.profile}`], { stdio: 'ignore' });
    } catch {
      console.error(`[${this.name}] profile ${this.profile} not removed: run  snap run --shell chromium -c 'rm -rf ${this.profile}'`);
    }
  }
}

/** Minimal client of the dev stack, authenticated by its own login. */
export class Api {
  constructor({ base, username, password }) {
    this.base = base;
    this.username = username;
    this.password = password;
    this.token = null;
    this.user = null;
  }

  async login() {
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (res.status !== 201) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    this.user = body.user;
    this.token = body.accessToken;
    return body;
  }

  async call(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async ok(method, path, body) {
    const r = await this.call(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  session() {
    return this.ok('GET', '/api/session');
  }

  command(targetId, body) {
    return this.ok('POST', `/api/remote/${encodeURIComponent(targetId)}/command`, body);
  }
}
