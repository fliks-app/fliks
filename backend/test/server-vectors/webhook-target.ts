import { PluginRegistryService } from '../../src/modules/plugins/plugin-registry.service';
import { emit } from './_util';

const TARGETS = [
  'https://hooks.example.com/x', 'https://hooks.example.com:8443/x?y=1#z', 'http://hooks.example.com/x', 'ftp://example.com/',
  'https://10.0.0.1/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://8.8.8.8/x', 'https://[::1]/x',
  'https://[fd00::1]/x', 'https://[2606:4700::1111]/x', 'https://[::ffff:10.0.0.1]/x', 'https://0x7f000001/x', 'https://2130706433/x',
  'https://localhost/x', 'https://192.168.1.10:443/', 'https://100.64.0.1/', 'https://224.0.0.1/', 'https://0.0.0.0/',
  'not a url', '', 'https://', 'https:///path', 'HTTPS://EXAMPLE.COM/x', 'https://user:pw@example.com/x', 'setting:url',
  'setting:other', 'setting:', 'https://exa mple.com/', 'https://例え.jp/', 'https://[2002:a00:1::]/x', 'https://172.16.0.1/',
];
const EVENTS = ['media.imported', 'settings.changed', 'media.unknown', ''];

const inputs: unknown[] = [];
for (const webhook of TARGETS) inputs.push({ event: 'media.imported', webhook });
for (const event of EVENTS) inputs.push({ event, webhook: 'https://hooks.example.com/x' });
inputs.push({ event: 42, webhook: 'https://hooks.example.com/x' }, { event: 'media.imported', webhook: null });

function run(i: { event: unknown; webhook: unknown }): unknown {
  const validate = (PluginRegistryService.prototype as any).validateWebhookDeclarations;
  const r = validate.call({}, [i], new Set(['url']));
  return r.ok ? { ok: true } : { reason: r.reason };
}

void emit('webhook-target', inputs, run);
