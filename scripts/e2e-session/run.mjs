#!/usr/bin/env node
// End-to-end check of the account session ("continue everywhere") with two headless Chromium instances.
// Usage: node scripts/e2e-session/run.mjs [--only=1,3] [--smoke]   (see README.md for the environment)
import { Api, Browser, assert, loadLabels, sleep, until } from './lib.mjs';

const env = (k, d) => process.env[`FLIKS_E2E_${k}`] ?? d;
const BASE = env('URL', 'http://localhost:4500').replace(/\/$/, '');
const LANG = env('LANG', 'en');
const MEDIA = {
  mediaId: Number(env('MEDIA_ID', 0)),
  mediaFileId: Number(env('FILE_ID', 0)),
  episodeId: env('EPISODE_ID') ? Number(env('EPISODE_ID')) : undefined,
};
const TRACKS = env('TRACK_IDS', '').split(',').filter(Boolean).map(Number);
const PARK_WAIT_MS = Number(env('PARK_WAIT_MS', 90_000));
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean).map(Number);
const smoke = process.argv.includes('--smoke');

const t = loadLabels(LANG);
const api = new Api({ base: BASE, username: env('USER', 'admin'), password: env('PASSWORD', 'password') });
const A = new Browser({ name: 'A', port: Number(env('PORT_A', 9333)), chromium: env('CHROMIUM', 'chromium') });
const B = new Browser({ name: 'B', port: Number(env('PORT_B', 9334)), chromium: env('CHROMIUM', 'chromium') });

// ---- page helpers --------------------------------------------------------------------------------------------

const J = JSON.stringify;
const waitReady = (b) => until(() => b.eval(`document.readyState === 'complete' && !!document.querySelector('app-root')?.children.length`), 30_000, `${b.name}: app boot`);

/** Fresh login cookie, forced desktop form factor and UI language, then the SSE target of the tab. */
async function openApp(b, accessToken) {
  await b.cdp.send('Network.setCookie', { name: 'fliks_access', value: accessToken, url: BASE });
  const go = async () => {
    await b.cdp.send('Page.navigate', { url: `${BASE}/?desktop=1` });
    await sleep(500);
    await waitReady(b);
  };
  await go();
  const changed = await b.eval(`(() => {
    const raw = localStorage.getItem('display.settings');
    const s = raw ? JSON.parse(raw) : {};
    if (s.language === ${J(LANG)}) return false;
    localStorage.setItem('display.settings', JSON.stringify({ ...s, language: ${J(LANG)} }));
    return true;
  })()`);
  if (changed) await go();
  const form = await b.eval('document.body.className');
  assert(!/\btv\b/.test(form), `${b.name}: form factor detected as tv (${form})`);
  const nonce = await until(() => b.eval(`sessionStorage.getItem('fliks.remote.tabNonce')`), 15_000, `${b.name}: tab nonce`);
  b.targetId = await until(async () => (await api.ok('GET', '/api/remote/targets')).find((x) => x.targetId.endsWith(`#${nonce}`))?.targetId, 20_000, `${b.name}: SSE target registered`);
}

const video = (b) => b.eval(`(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused } : null; })()`);
const stripText = (b) => b.eval(`document.querySelector('app-cast-overlay')?.innerText ?? ''`);
const dialogText = (b) => b.eval(`document.querySelector('dialog[open]')?.innerText ?? ''`);
const path = (b) => b.eval('location.pathname');

/** Clicks the first button of `scope` whose aria-label or text is `label`. */
const click = (b, scope, label) =>
  b.eval(`(() => {
    const root = document.querySelector(${J(scope)});
    const btn = root && [...root.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? x.innerText.trim()) === ${J(label)} || x.innerText.trim() === ${J(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
const clickWait = (b, scope, label, ms = 10_000) => until(() => click(b, scope, label), ms, `${b.name}: button "${label}" in ${scope}`);

/** First "m:ss" or "h:mm:ss" of the strip's detail line, in seconds. */
function stripPosition(text) {
  const m = text.match(/(?:^|\n|·)\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*\//);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

const playingVideo = (b) => until(async () => { const v = await video(b); return v && !v.paused && v.t > 1.5 && v; }, 60_000, `${b.name}: video playing`);
/** Position of the first moment the video of `b` plays: the start position of a handover. */
const firstPlayedAt = async (b) => (await until(async () => { const v = await video(b); return v && !v.paused && v.t > 0 && v; }, 30_000, `${b.name}: video starts`, 100)).t;

const startVideo = (b) => api.command(b.targetId, { action: 'load', ...MEDIA });
const startAudio = (b, extra = {}) =>
  api.command(b.targetId, { action: 'load', kind: 'album', queue: { itemIds: TRACKS, index: 0 }, shuffle: false, repeat: 'off', ...extra });

const liveSession = (pred, ms, label) => until(async () => { const s = await api.session(); return s && pred(s) && s; }, ms, label);

// ---- setup / cleanup shared by every check -------------------------------------------------------------------

async function ensureBrowsers() {
  for (const b of [A, B]) {
    if (b.crashed) await b.stop();
    if (!b.proc) await b.start();
  }
}

/** Stops what plays, drops the row, applies the preference, reloads both tabs. */
async function reset(prefs) {
  await api.login();
  await ensureBrowsers();
  for (const x of await api.ok('GET', '/api/remote/targets')) {
    if (x.nowPlaying) await api.command(x.targetId, { action: 'stop' }).catch(() => undefined);
  }
  await until(async () => { const s = await api.session(); return !s || s.state === 'parked'; }, 15_000, 'sessions stopped').catch(() => undefined);
  await api.call('DELETE', '/api/session');
  await api.ok('PUT', `/api/users/${api.user.id}`, prefs);
  await api.login(); // the cached user carries the new preference
  for (const b of [A, B]) await openApp(b, api.token);
  assert((await api.session()) === null, 'account session not empty after cleanup');
}

const ON = { sessionSync: true, sessionKinds: null };

// ---- checks --------------------------------------------------------------------------------------------------

const checks = [
  [1, 'option off: no strip, empty session', async () => {
    await reset({ sessionSync: false, sessionKinds: null });
    await startVideo(A);
    await playingVideo(A);
    await sleep(8000);
    assert((await api.session()) === null, 'GET /api/session is not null while the option is off');
    assert((await stripText(B)).trim() === '', `B shows a strip: ${J(await stripText(B))}`);
  }],

  [2, 'option on: B shows the strip near A position', async () => {
    await reset(ON);
    await startVideo(A);
    await playingVideo(A);
    const s = await liveSession((x) => x.state === 'playing', 20_000, 'session claimed by A');
    assert(s.owner.targetId === A.targetId, `owner is ${s.owner.targetId}, expected ${A.targetId}`);
    await until(async () => stripPosition(await stripText(B)) !== null, 10_000, 'B strip with a position');
    const [text, a] = [await stripText(B), await video(A)];
    const pos = stripPosition(text);
    assert(Math.abs(pos - a.t) <= 3, `strip position ${pos} s vs A ${a.t.toFixed(1)} s`);
    if (s.owner.deviceName) assert(text.includes(s.owner.deviceName), `strip lacks the owner name ${J(s.owner.deviceName)}: ${J(text)}`);
    else console.log('    note: the owner has no device name (web client), name assertion skipped');
  }],

  [3, 'play here on B: handover and silent close on A', async () => {
    await reset(ON);
    await startVideo(A);
    await playingVideo(A);
    const before = await liveSession((x) => x.owner.targetId === A.targetId, 20_000, 'A owns the session');
    await until(async () => (await stripText(B)).includes(t('session.play_here')), 10_000, 'B strip with the play-here button');
    const pA = (await video(A)).t;
    await clickWait(B, 'app-cast-overlay', t('session.play_here'));
    const startB = await firstPlayedAt(B);
    assert(Math.abs(startB - pA) <= 2, `B started at ${startB.toFixed(1)} s, A was at ${pA.toFixed(1)} s`);
    await until(async () => !(await video(A)) && !(await path(A)).startsWith('/watch'), 10_000, 'A player closed');
    const after = await liveSession((x) => x.owner.targetId === B.targetId, 15_000, 'B owns the session');
    assert(after.epoch > before.epoch, `epoch ${before.epoch} -> ${after.epoch}`);
  }],

  [4, 'transfer from B to A through the API', async () => {
    await reset(ON);
    await startVideo(B);
    await playingVideo(B);
    await liveSession((x) => x.owner.targetId === B.targetId, 20_000, 'B owns the session');
    const pB = (await video(B)).t;
    await api.ok('POST', '/api/session/transfer', { toTargetId: A.targetId });
    const startA = await firstPlayedAt(A);
    assert(Math.abs(startA - pB) <= 3, `A started at ${startA.toFixed(1)} s, B was at ${pB.toFixed(1)} s`);
    await liveSession((x) => x.owner.targetId === A.targetId, 15_000, 'A owns the session');
  }],

  [5, 'owner killed: parked strip, position kept, resume', async () => {
    await reset(ON);
    await startVideo(A);
    await playingVideo(A);
    await liveSession((x) => x.owner.targetId === A.targetId, 20_000, 'A owns the session');
    await sleep(3000);
    const pA = (await video(A)).t;
    await A.crash();
    const parked = await liveSession((x) => x.state === 'parked', PARK_WAIT_MS, 'session parked');
    assert(parked.positionSeconds <= pA + 3 && parked.positionSeconds >= pA - 35, `parked at ${parked.positionSeconds} s, A was at ${pA.toFixed(1)} s`);
    await until(async () => (await stripText(B)).includes(t('session.resume')), 10_000, 'B parked strip with the resume button');
    await clickWait(B, 'app-cast-overlay', t('session.resume'));
    const startB = await firstPlayedAt(B);
    assert(Math.abs(startB - parked.positionSeconds) <= 3, `B resumed at ${startB.toFixed(1)} s, parked at ${parked.positionSeconds} s`);
  }],

  [6, 'audio: queue of 3, shuffle and next from the observer', async () => {
    assert(TRACKS.length === 3, 'FLIKS_E2E_TRACK_IDS needs 3 track item ids');
    await reset(ON);
    await startAudio(A);
    const s0 = await liveSession((x) => x.owner.targetId === A.targetId && x.queue?.itemIds.length === 3, 30_000, 'A owns a 3-track queue');
    await until(async () => (await stripText(B)).length > 0, 10_000, 'B audio strip');
    await until(() => B.eval(`(() => { const x = document.querySelector('app-cast-overlay button.flex-1'); if (!x) return false; x.click(); return true; })()`), 10_000, 'B strip body (opens the controller)');
    await clickWait(B, 'app-session-audio-controller dialog[open]', t('music_player.shuffle'));
    await liveSession((x) => x.queue?.shuffle === true, 15_000, 'queue shuffled');
    const mid = await api.session();
    await clickWait(B, 'app-session-audio-controller dialog[open]', t('music_player.next'));
    await liveSession((x) => x.item.id !== mid.item.id, 15_000, 'next track');
    const end = await api.session();
    assert(end.owner.targetId === A.targetId && end.epoch === s0.epoch, 'the observer took the session over');
  }],

  [7, 'scope album: a video on A does not supersede B audio', async () => {
    assert(TRACKS.length === 3, 'FLIKS_E2E_TRACK_IDS needs 3 track item ids');
    await reset({ sessionSync: true, sessionKinds: ['album'] });
    await startAudio(B);
    const s0 = await liveSession((x) => x.owner.targetId === B.targetId && x.item.kind === 'album', 30_000, 'B owns the audio session');
    await startVideo(A);
    await playingVideo(A);
    await sleep(10_000);
    const s1 = await api.session();
    assert(s1 && s1.owner.targetId === B.targetId && s1.epoch === s0.epoch, `session changed: ${J(s1 && { owner: s1.owner.targetId, epoch: s1.epoch })}`);
    assert(!(await dialogText(B)), `B shows a modal: ${J(await dialogText(B))}`);
  }],
];

// ---- run -----------------------------------------------------------------------------------------------------

const results = [];

async function main() {
  if (smoke) {
    await api.login();
    await ensureBrowsers();
    for (const b of [A, B]) await openApp(b, api.token);
    console.log(`PASS smoke: login, two browsers, SSE targets ${A.targetId} / ${B.targetId}`);
    return;
  }
  assert(MEDIA.mediaId && MEDIA.mediaFileId, 'FLIKS_E2E_MEDIA_ID and FLIKS_E2E_FILE_ID are required');
  for (const [n, name, fn] of checks) {
    if (only.length && !only.includes(n)) continue;
    const t0 = Date.now();
    let status = 'PASS';
    let detail = '';
    try {
      await fn();
    } catch (e) {
      status = 'FAIL';
      detail = e.message;
    }
    const ms = Date.now() - t0;
    console.log(`${status} ${n}. ${name} (${(ms / 1000).toFixed(1)} s)${detail ? `\n    ${detail}` : ''}`);
    results.push({ n, name, status, ms, detail });
  }
  console.log('\n #  result  time    check');
  for (const r of results) console.log(` ${r.n}  ${r.status}    ${(r.ms / 1000).toFixed(0).padStart(4)} s  ${r.name}`);
  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error(`FAIL setup: ${e.message}`);
  process.exitCode = 1;
} finally {
  try {
    await api.login();
    for (const x of await api.ok('GET', '/api/remote/targets')) if (x.nowPlaying) await api.command(x.targetId, { action: 'stop' }).catch(() => undefined);
    await sleep(1500);
    await api.call('DELETE', '/api/session');
  } catch {
    /* stack gone */
  }
  await A.dispose();
  await B.dispose();
}
