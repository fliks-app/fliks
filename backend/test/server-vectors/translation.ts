import { Logger } from '@nestjs/common';
import * as core from '../../src/modules/subtitles/translation-core';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);

// Virtual clock: a sleep advances `now` and fires at once.
let now = 1_000_000;
const sleeps: number[] = [];
(globalThis as any).setTimeout = (fn: () => void, ms: number) => {
  sleeps.push(ms);
  now += ms;
  fn();
  return 0;
};
Date.now = () => now;

type Step = { status?: number; body?: string; headers?: Record<string, string>; throw?: string };
let script: Step[] = [];
let fetchCalls = 0;
(globalThis as any).fetch = async () => {
  const s = script[Math.min(fetchCalls++, script.length - 1)];
  if (s.throw !== undefined) throw new Error(s.throw);
  return new Response(s.status === 204 ? null : (s.body ?? ''), { status: s.status ?? 200, headers: s.headers });
};

const rng = mulberry32(0x7a45);

// ---- retry -----------------------------------------------------------------------------------
const BODIES = ['', 'plain failure', 'quota exceeded', 'Rate limit reached: TPM 6000', 'Too many requests per minute', 'PerDay quota', 'requests per day exceeded',
  '{"error":{"details":[{"retryDelay":"38s"}]}}', '{"error":{"details":[{"retryDelay":"1.5s"}]}}', '{"error":{"details":[{"retryDelay":"1m"}]}}',
  '{"error":{"details":[{"x":1},{"retryDelay":"7s"}]}}', 'not json {', 'Resource exhausted PerMinute', 'quota PerMinute', 'context_length_exceeded', 'request too large for model',
  'max_tokens is too high', 'x'.repeat(300), '{"error":{"details":"nope"}}', '{"error":{"details":[{"retryDelay":"0s"}]}}'];
const STATUSES = [200, 429, 500, 502, 503, 504, 400, 401, 404, 413, 408];
const HEADERS = [undefined, { 'retry-after': '3' }, { 'retry-after': '0' }, { 'retry-after': 'abc' }, { 'retry-after': '120' }, { 'retry-after': '-5' },
  { 'retry-after': '1.5' }, { 'retry-after': ' 7 ' }, { 'retry-after': '1e2' }, { 'retry-after': '' }];
const retryCases: unknown[] = [];
for (let i = 0; i < 260; i++) {
  const n = ri(rng, 1, 5);
  retryCases.push({
    fn: 'postWithRetry',
    script: Array.from({ length: n }, () => {
      if (rng() < 0.12) return { throw: pick(rng, ['fetch failed', 'timeout']) };
      const status = rng() < 0.2 ? 200 : pick(rng, STATUSES);
      return { status, body: status === 200 ? 'ok' : pick(rng, BODIES), ...(pick(rng, HEADERS) ? { headers: pick(rng, HEADERS) } : {}) };
    }),
  });
}
for (const status of [429, 500, 503, 413, 400]) {
  retryCases.push({ fn: 'postWithRetry', script: [{ status, body: 'plain' }] });
  retryCases.push({ fn: 'postWithRetry', script: [{ status, body: 'plain' }, { status: 200, body: 'ok' }] });
}
retryCases.push({ fn: 'postWithRetry', script: [{ throw: 'down' }] });

// ---- batching --------------------------------------------------------------------------------
const MODES = ['echo', 'tooLargeOver', 'mismatchOver', 'dropLastOver', 'mismatchContainsBad', 'badAlways', 'tooLargeAlways', 'errorAt', 'tooLargeTokens'];
// A text is [UTF-16 length, kind (0 = "x", 1 = astral, 2 = "é"), bad]; the Rust replay expands it the same way.
type Spec = [number, number, number];
function expand([len, kind, bad]: Spec): string {
  const unit = ['x', '😀', 'é'][kind];
  let t = '';
  while (t.length < len) t += unit;
  return bad ? t + 'BAD' : t;
}
const spec = (): Spec => [pick(rng, [0, 1, 3, 10, 40, 120, 400]), pick(rng, [0, 0, 1, 2]), rng() < 0.03 ? 1 : 0];
const batchCases: unknown[] = [];
for (let i = 0; i < 180; i++) {
  const n = pick(rng, [0, 1, 2, 5, 9, 23, 60, 150, 410]);
  const mode = pick(rng, MODES);
  batchCases.push({
    fn: 'translateWithBatching',
    texts: Array.from({ length: n }, spec),
    mode,
    modeArg: mode === 'errorAt' ? ri(rng, 1, 4) : mode === 'tooLargeTokens' ? pick(rng, [200, 600, 1500]) : pick(rng, [1, 2, 3, 4, 8, 30, 100]),
    limits: {
      maxTokensPerRequest: pick(rng, [0, 0, 1000, 2048, 3000, 5000, 12000]),
      tokensPerMinute: pick(rng, [0, 0, 0, 2000, 6000, 20000]),
      key: `k${i}`,
      outputCeiling: pick(rng, [8192, 8192, 65536, 500, 2000]),
      batchCeiling: pick(rng, [150, 150, 500, 0, 3, 7, 1]),
    },
    systemLen: pick(rng, [0, 40, 400, 1200]),
  });
}

async function batching(i: any) {
  now = 1_000_000;
  sleeps.length = 0;
  const calls: unknown[] = [];
  const progress: unknown[] = [];
  let k = 0;
  const callBatch = async (texts: string[], max: number) => {
    k++;
    calls.push({ len: texts.length, firstLen: texts[0]?.length ?? null, max, t: now });
    switch (i.mode) {
      case 'echo': return texts.map((t) => 'T:' + t);
      case 'tooLargeOver': if (texts.length > i.modeArg) throw new core.TranslationPayloadTooLargeError(`big ${texts.length}`); return texts.map((t) => 'T:' + t);
      case 'mismatchOver': return texts.length > i.modeArg ? null : texts.map((t) => 'T:' + t);
      case 'dropLastOver': return texts.length > i.modeArg ? texts.slice(1).map((t) => 'T:' + t) : texts.map((t) => 'T:' + t);
      case 'mismatchContainsBad': return texts.some((t) => t.includes('BAD')) ? null : texts.map((t) => 'T:' + t);
      case 'badAlways': return null;
      case 'tooLargeAlways': throw new core.TranslationPayloadTooLargeError('always');
      case 'errorAt': if (k === i.modeArg) throw new Error('boom'); return texts.map((t) => 'T:' + t);
      case 'tooLargeTokens': if (texts.reduce((n, t) => n + core.estimateTokens(t), 0) > i.modeArg) throw new core.TranslationPayloadTooLargeError('tokens'); return texts.map((t) => 'T:' + t);
    }
    return null;
  };
  let out: unknown;
  try {
    out = { result: await core.translateWithBatching(i.texts.map(expand), callBatch, i.limits, 'x'.repeat(i.systemLen), (d, t) => progress.push([d, t])) };
  } catch (e) {
    out = { error: { name: (e as Error).constructor.name, message: (e as Error).message } };
  }
  return { ...(out as object), calls, progress, sleeps: [...sleeps] };
}

// ---- prompts, numbering, register -------------------------------------------------------------
const textCases: unknown[] = [];
const CTX = [{}, { title: 'Show' }, { title: 'Show', year: 2020, mediaType: 'series', genres: ['Drama', 'Crime'], overview: '  A long synopsis. ' + 'x'.repeat(290) },
  { genres: ['Drama'] }, { year: 2020 }, { title: '', overview: '   ' }, { title: 'Film', year: 0, mediaType: 'movie', genres: [], overview: '😀'.repeat(200) }, { title: 'Q"uote', mediaType: 'series' }];
for (const context of CTX) {
  for (const source of ['en', 'und', 'xx', '', 'fr', 'zz']) {
    for (const target of ['fr', 'de', 'ja', 'es', 'it', 'pt', 'nl', 'ru', 'en', 'xx']) {
      for (const register of [undefined, 'tu', 'vous', 'du']) {
        if (rng() < 0.5) continue;
        textCases.push({ fn: 'buildSystemInstruction', req: { sourceLanguage: source, targetLanguage: target, context, ...(register ? { register } : {}) } });
      }
    }
  }
  for (const target of ['fr', 'de', 'ja', 'es', 'it', 'pt', 'nl', 'ru']) {
    textCases.push({ fn: 'buildRegisterProbe', req: { sourceLanguage: 'en', targetLanguage: target, context }, sample: ['Hello', '', 'World'] });
  }
}
for (const [target, answers] of Object.entries({ fr: ['tu', 'Tu\n', '  vous.', 'Pas tu, mais vous.', 'tu vous', 'maybe', '', '<think>vous</think>tu', '<think>tu or vous? unterminated', '<THINK>x</THINK>\nVOUS', 'vous!\n', 'tutu', 'TU'],
  de: ['du', 'Sie', 'sie', 'DU', 'du, Sie', 'siehe'], es: ['tú', 'usted', 'Tú.', 'tu'], it: ['Lei', 'tu', 'lei'], pt: ['você', 'voce', 'tu'], nl: ['je', 'u', 'u, je'], ru: ['ты', 'вы', 'Вы', 'ТЫ'], ja: ['tu'] })) {
  for (const answer of answers) textCases.push({ fn: 'parseRegister', answer, target });
}
const N = (k: number) => Array.from({ length: k }, (_, i) => `line ${i}`);
for (const [len, w, p] of [[5, 3, 12], [36, 3, 12], [37, 3, 12], [600, 2, 4], [600, 3, 12], [100, 1, 1], [0, 3, 12], [13, 1, 12], [50, 3, 5]]) {
  textCases.push({ fn: 'registerSample', texts: N(len), windows: w, perWindow: p });
}
for (const response of ['#1#\nA\n#2#\nB', '#1# A\n#2# B', '```\n#1#\nA\n#2#\nB\n```', '#1#\r\nA\r\n#2#\r\nB', '#1#\nA\n#1#\nA2\n#2#\nB', '#1#\nA\n#3#\nC', 'pre\n#1#\nA\n#2#\nB\n#3#\nextra',
  '  #1#  \nmulti\nline\n#2#\n', '#2#\nB\n#1#\nA', '#1#\n\n#2#\nB', 'no markers', '', '#01#\nA\n#2#\nB', '#1#A\n#2#B', ' #1#\n A \n #2#\n B ', '#1#\n```x\ny\n#2#\nz']) {
  for (const count of [2, 3]) textCases.push({ fn: 'parseNumbered', response, count });
}
for (const texts of [[], ['a'], ['a', 'b\nc'], ['', 'x']]) textCases.push({ fn: 'buildPayload', texts });
for (const k of [0, 1, 2]) {
  for (const answer of ['tu', 'vous', 'nope', '<think>x</think> tu']) {
    for (const [target, register] of [['fr', undefined], ['fr', 'tu'], ['ja', undefined], ['de', undefined]]) {
      textCases.push({ fn: 'withRegister', req: { sourceLanguage: 'en', targetLanguage: target, context: { mediaType: k ? 'series' : 'movie' }, ...(register ? { register } : {}) }, texts: N(5 + k * 60), answer, fail: k === 2 });
    }
  }
}
textCases.push({ fn: 'estimateTokens', text: '' }, { fn: 'estimateTokens', text: 'abcd' }, { fn: 'estimateTokens', text: 'abcde' }, { fn: 'estimateTokens', text: '😀😀' });

async function run(i: any): Promise<unknown> {
  switch (i.fn) {
    case 'postWithRetry': {
      now = 1_000_000;
      sleeps.length = 0;
      script = i.script;
      fetchCalls = 0;
      try {
        const res = await core.postWithRetry('http://x/y', { method: 'POST' }, 'Label');
        return { ok: true, status: res.status, calls: fetchCalls, sleeps: [...sleeps] };
      } catch (e) {
        const err = e as any;
        return { error: { name: err.constructor.name, message: err.message, ...(err.scope ? { scope: err.scope } : {}) }, calls: fetchCalls, sleeps: [...sleeps] };
      }
    }
    case 'translateWithBatching': return batching(i);
    case 'buildSystemInstruction': return core.buildSystemInstruction(i.req);
    case 'buildRegisterProbe': return core.buildRegisterProbe(i.req, i.sample);
    case 'parseRegister': return core.parseRegister(i.answer, i.target);
    case 'registerSample': return core.registerSample(i.texts, i.windows, i.perWindow);
    case 'parseNumbered': return core.parseNumbered(i.response, i.count);
    case 'buildPayload': return core.buildPayload(i.texts);
    case 'estimateTokens': return core.estimateTokens(i.text);
    case 'withRegister': {
      const asks: unknown[] = [];
      const req = await core.withRegister(i.req, i.texts, async (system, user) => {
        asks.push({ system, user });
        if (i.fail) throw new Error('down');
        return i.answer;
      });
      return { register: req.register ?? null, asks };
    }
  }
  throw new Error(i.fn);
}

emit('translation', [...retryCases, ...batchCases, ...textCases], run).then(() =>
  console.log(`translation retry=${retryCases.length} batching=${batchCases.length} text=${textCases.length}`),
);
