// Headless smoke test for the mpv control plane (no GUI required).
//
// Generates a short A/V test clip with ffmpeg, drives it through MpvPlayer
// over the JSON IPC socket, and asserts the control surface behaves:
//   spawn → load → firstFrame → time advances → seek → tracks → speed → stop.
//
// Run: node spike/smoke-mpv.mjs   (from desktop/)

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MpvPlayer } from './mpv-player.mjs';

const CLIP = path.join(os.tmpdir(), 'fliks-mpv-smoke.mp4');

function makeClip() {
  if (fs.existsSync(CLIP)) return;
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    CLIP,
  ]);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('• generating test clip…');
  makeClip();

  const mpv = new MpvPlayer({ headless: true });
  let firstFrame = false;
  let lastTime = -1;
  const states = [];
  mpv.on('firstFrame', () => (firstFrame = true));
  mpv.on('timeUpdate', (e) => (lastTime = e.position));
  mpv.on('stateChanged', (e) => states.push(e.state));
  mpv.on('error', (e) => console.log('  [mpv error]', e.message));

  console.log('• starting mpv…');
  await mpv.start();
  check('mpv spawned + IPC connected', true);

  console.log('• loading clip…');
  await mpv.load({ url: CLIP });
  await mpv.play();

  // Let playback run a beat.
  await wait(1200);
  check('playback-restart → firstFrame fired', firstFrame);
  check('time-pos advancing', lastTime > 0, `pos=${lastTime?.toFixed(2)}s`);

  const dur = (await mpv.getPosition()).duration;
  check('duration reported', dur > 5 && dur < 7, `${dur?.toFixed(2)}s`);

  console.log('• seeking to 4.0s…');
  await mpv.seek(4.0);
  await wait(400);
  const afterSeek = (await mpv.getPosition()).position;
  check('seek landed near target', afterSeek >= 3.5, `pos=${afterSeek?.toFixed(2)}s`);

  const audio = await mpv.getAudioTracks();
  check('audio track listed', audio.length >= 1, `${audio.length} track(s)`);

  console.log('• setting speed 1.5x…');
  await mpv.setPlaybackRate(1.5);
  check('set speed ok', (await mpv._get('speed')) === 1.5);

  console.log('• pause…');
  await mpv.pause();
  await wait(150);
  check('pause → paused state', states.includes('paused'));

  await mpv.destroy();
  check('destroyed cleanly', true);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('SMOKE ERROR:', e);
  process.exit(1);
});
