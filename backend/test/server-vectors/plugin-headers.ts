import * as http from 'http';
import { PluginProxyController } from '../../src/modules/plugins/proxy/plugin-proxy.controller';
import { emit } from './_util';

const NAMES = [
  'Content-Type', 'content-type', 'CONTENT-DISPOSITION', 'Cache-Control', 'ETag', 'Last-Modified', 'Set-Cookie', 'Location',
  'Authorization', 'X-Custom', 'content-type ', 'content type', 'content:type', '', 'Content-Length', 'Transfer-Encoding',
  'etag\r\n', 'ctnté', 'Strict-Transport-Security', 'Access-Control-Allow-Origin',
];
const VALUES = [
  'text/plain', 'attachment; filename="a.txt"', 'max-age=60', '"abc"', 'Wed, 21 Oct 2015 07:28:00 GMT', '',
  'a\r\nSet-Cookie: x=1', 'a\nb', 'a\u0000b', 'café', 'euro €', 'tab\there', 'ctl\u0001', ' padded ', 'del\u007f',
];

const inputs: unknown[] = [];
for (const name of NAMES) for (const value of VALUES) inputs.push({ name, value });
// A non-string value is dropped before any check.
inputs.push({ name: 'Content-Type', value: 42 });

async function run(i: { name: string; value: unknown }): Promise<unknown> {
  const set: [string, string][] = [];
  const res = {
    status() {
      return res;
    },
    setHeader(n: string, v: string) {
      http.validateHeaderName(n);
      http.validateHeaderValue(n, v);
      set.push([n, v]);
    },
    send() {},
  };
  const registry = { processStateOf: () => 'ready', processStatusMessageOf: () => '' };
  const proc = { callPlugin: async () => ({ status: 200, headers: { [i.name]: i.value }, body: '' }) };
  const ctrl = new PluginProxyController(registry as never, proc as never);
  const req = { user: { id: 1 }, method: 'GET', query: {}, body: {}, originalUrl: '/api/plugins/x/y' };
  try {
    await ctrl.proxy('x', req as never, res as never);
  } catch {
    return { header: 'throws' };
  }
  return { header: set.length > 1 ? set[1] : null };
}

void emit('plugin-headers', inputs, run);
