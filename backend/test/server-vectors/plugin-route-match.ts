import { match } from 'path-to-regexp';
import { emit } from './_util';

const PATTERNS = [
  '/hello', '/media/:id', '/a/:x/b/:y', '/files/*rest', '/x{/:opt}', '/e/:id.json', '/v/:a-:b', '/Upper/Case',
  '/caf%C3%A9', '/:a/*b', '/', '/q/:n{/*more}', '/bad/:', '/bad/*', '/bad/(x)', '/bad/:a:b', '/bad/{x',
  '/u/:ünï', '/r/:a?', '/esc/\\:lit', '/t/', '/w/*w/end',
];
const PATHS = [
  '/hello', '/hello/', '/HELLO', '/hello//', '/media/42', '/media/', '/media/a%2Fb', '/media/%E2%82%AC', '/media/%E0%A4%A',
  '/media/%ZZ', '/a/1/b/2', '/a/1/B/2/', '/files/a/b/c', '/files/', '/files/a%20b/c', '/files/%FF', '/x', '/x/1', '/x/',
  '/e/7.json', '/e/.json', '/v/1-2', '/v/1-2-3', '/upper/case', '/café', '/caf%C3%A9', '/k/v/w', '/', '', '/q/1',
  '/q/1/2/3', '/u/z', '/r/1', '/esc/:lit', '/t/', '/t', '/w/a/b/end', '/w/end',
];

const inputs: unknown[] = [];
for (const path of PATTERNS) for (const input of PATHS) inputs.push({ path, input });

function run(i: { path: string; input: string }): unknown {
  let m;
  try {
    m = match<Record<string, string | string[]>>(i.path);
  } catch {
    return { compile: 'error' };
  }
  try {
    const r = m(i.input);
    return r === false ? { match: null } : { match: r.params };
  } catch {
    return { match: 'throws' };
  }
}

void emit('plugin-route-match', inputs, run);
