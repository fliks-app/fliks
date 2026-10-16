import { Logger } from '@nestjs/common';
import axios from 'axios';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateNotificationConnectionDto } from '../../src/modules/notifications/dto/create-notification-connection.dto';
import { NOTIFICATION_EVENTS } from '../../src/modules/notifications/entities/notification-connection.entity';
import {
  NotificationsService,
  SUBSCRIBABLE_NOTIFICATION_EVENTS,
  redactNotificationSecrets,
} from '../../src/modules/notifications/notifications.service';
import { emit } from './_util';

Logger.overrideLogger(false);

// `send`, `formatMessage` and `normalizeSettings` are private: drive them directly, axios.post recorded.
const service = new NotificationsService({} as never) as any;
let sent: any;
(axios as any).post = async (url: string, body: unknown, config?: { headers?: unknown }) => {
  sent = { url, body: JSON.parse(JSON.stringify(body)), headers: config?.headers ?? {} };
  return {};
};

const send = (type: string, settings: object, event: string, payload: object = {}) => ({ fn: 'send', type, settings, event, payload });
const fmt = (event: string, payload: object = {}) => ({ fn: 'format', event, payload });
const norm = (type: string, settings: object, existing?: object) => ({ fn: 'normalize', type, settings, existing });
const val = (body: object) => ({ fn: 'validate', body });
const redact = (type: string, settings: object) => ({ fn: 'redact', type, settings });

const TYPES = ['discord', 'slack', 'webhook', 'gotify', 'ntfy'];
const CONF: Record<string, object> = {
  discord: { webhookUrl: 'https://discord.test/api/webhooks/1/abc' },
  slack: { webhookUrl: 'https://hooks.slack.test/T/B/x' },
  webhook: { url: 'https://hook.test/in', token: 'tk' },
  gotify: { url: 'https://gotify.test', token: 'tok' },
  ntfy: { url: 'https://ntfy.test', topic: 'media', token: 'tk' },
};
// Payloads as the callers emit them (notifications.md rule 19).
const PAYLOAD: Record<string, object> = {
  'request.created': { title: 'Dune', mediaType: 'movie' },
  'request.approved': { title: 'Dune' },
  'request.declined': { title: 'Dune', reason: 'no' },
  'request.processing': { title: 'Dune', mediaType: 'movie' },
  'request.available': { title: 'Dune', mediaType: 'movie' },
  'request.delete.created': { title: 'Dune', mediaType: 'movie' },
  'request.delete.approved': { title: 'Dune', mediaType: 'movie' },
  'request.delete.declined': { title: 'Dune', reason: 'no' },
  'grab.started': { title: 'Dune', indexer: 'x' },
  'download.complete': { title: 'Dune', quality: '1080p', sourceTitle: 'Dune.2021.1080p' },
  'health.issue': { test: true, message: 'Test notification from Fliks' },
  'subtitle.downloaded': { title: 'Dune', language: 'fr', provider: 'os', score: 90 },
  'subtitle.upgraded': { title: 'Dune', language: 'fr', oldScore: 80, newScore: 95, provider: 'os' },
  'subtitle.failed': { title: 'Dune', language: 'fr', error: 'boom' },
  'subtitle.synced': { language: 'fr', subtitleId: 7 },
  'livetv.account_expiring': { sourceName: 'IPTV', expiresAt: '2026-01-01T00:00:00.000Z' },
  'livetv.account_expired': { sourceName: 'IPTV', expiresAt: null },
  'livetv.adult_guard_failed': { sourceName: 'IPTV' },
};

const inputs: unknown[] = [];
for (const e of NOTIFICATION_EVENTS) {
  inputs.push(fmt(e, PAYLOAD[e]));
  for (const t of TYPES) inputs.push(send(t, CONF[t], e, PAYLOAD[e]));
}

// edge payloads
const edge: [string, object][] = [
  ['request.created', {}],
  ['request.created', { title: null }],
  ['request.created', { title: 42 }],
  ['request.created', { title: { a: 1 } }],
  ['request.created', { title: ['a', null, 'b'] }],
  ['request.created', { title: true }],
  ['request.created', { title: 1.5e21 }],
  ['request.created', { title: 0.0000001 }],
  ['request.created', { title: '<@&1> @everyone **bold**' }],
  ['request.created', { title: 'Les Misérables – 日本語 🎬' }],
  ['subtitle.upgraded', { language: 'fr', oldScore: 1, newScore: 2, provider: 'p' }],
  ['subtitle.downloaded', { title: 'Dune' }],
  ['subtitle.downloaded', { title: 'Dune', language: null }],
  ['subtitle.downloaded', { title: 'Dune', language: 5 }],
  ['subtitle.synced', {}],
  ['health.issue', {}],
  ['health.issue', { message: null }],
  ['health.issue', { message: 12 }],
  ['health.issue', { message: 'disk full' }],
  ['livetv.account_expiring', {}],
  ['livetv.account_expired', { sourceName: null }],
  ['livetv.adult_guard_failed', { sourceName: 'A "B"' }],
  ['custom.event', { a: 1, b: [1, 2], c: null }],
  ['custom.event', {}],
  ['request.approved', { title: 'Dune', event: 'override', extra: { n: 1 } }],
];
for (const [e, p] of edge) {
  inputs.push(fmt(e, p));
  for (const t of TYPES) inputs.push(send(t, CONF[t], e, p));
}

// channel config
inputs.push(
  send('discord', { webhookUrl: 'https://d.test/h', username: 'Bot' }, 'request.created', { title: 'T' }),
  send('discord', { webhookUrl: 'https://d.test/h', username: 5 }, 'request.created', { title: 'T' }),
  send('discord', { webhookUrl: 'https://d.test/h', username: null }, 'request.created', { title: 'T' }),
  send('discord', { webhookUrl: 'https://d.test/h', username: '' }, 'request.created', { title: 'T' }),
  send('discord', {}, 'request.created', { title: 'T' }),
  send('discord', { webhookUrl: '' }, 'request.created', { title: 'T' }),
  send('discord', { webhookUrl: null }, 'request.created', { title: 'T' }),
  send('discord', { url: 'https://d.test/h' }, 'request.created', { title: 'T' }),
  send('slack', {}, 'request.created', { title: 'T' }),
  send('slack', { webhookUrl: '' }, 'request.created', { title: 'T' }),
  send('webhook', {}, 'request.created', { title: 'T' }),
  send('webhook', { url: '' }, 'request.created', { title: 'T' }),
  send('webhook', { url: 'https://h.test/x' }, 'request.created', { title: 'T' }),
  send('webhook', { url: 'https://h.test/x', token: '' }, 'request.created', { title: 'T' }),
  send('webhook', { url: 'https://h.test/x', token: 'a b' }, 'request.created', { title: 'T' }),
  send('webhook', { url: 'https://h.test/x', token: 123 }, 'request.created', { title: 'T' }),
  send('webhook', { url: 'https://h.test/x/' }, 'request.created', { title: 'T' }),
  send('gotify', { url: 'https://g.test/', token: 'tok' }, 'request.created', { title: 'T' }),
  send('gotify', { url: 'https://g.test//', token: 'tok' }, 'request.created', { title: 'T' }),
  send('gotify', { url: 'https://g.test', token: 'a b&c' }, 'request.created', { title: 'T' }),
  send('gotify', { url: 'https://g.test', token: 'é/+=?#' }, 'request.created', { title: 'T' }),
  send('gotify', { url: 'https://g.test', token: 12345 }, 'request.created', { title: 'T' }),
  send('gotify', { url: 'https://g.test' }, 'request.created', { title: 'T' }),
  send('gotify', { token: 'tok' }, 'request.created', { title: 'T' }),
  send('gotify', { url: '/', token: 'tok' }, 'request.created', { title: 'T' }),
  send('gotify', { url: 'https://g.test', token: '' }, 'request.created', { title: 'T' }),
  send('gotify', {}, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test/' }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test//' }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', topic: '' }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', topic: null }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', topic: 'a b/c' }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', topic: 7 }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', topic: 0 }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', token: '' }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', token: 5 }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test', token: 'tk' }, 'request.created', { title: 'T' }),
  send('ntfy', {}, 'request.created', { title: 'T' }),
  send('ntfy', { url: '' }, 'request.created', { title: 'T' }),
  send('ntfy', { url: '/' }, 'request.created', { title: 'T' }),
  send('ntfy', { url: 'https://n.test' }, 'request.created', { title: 'Les Misérables – 日本語' }),
  send('ntfy', { url: 'https://n.test' }, 'custom.event', { a: 1 }),
);

// normalize
inputs.push(
  ...['webhook', 'gotify', 'ntfy'].map((t) => norm(t, { webhookUrl: 'https://x.test', topic: 'media', token: 'tk' })),
  norm('discord', { webhookUrl: 'https://discord.test/hook' }),
  norm('slack', { webhookUrl: 'https://slack.test/hook', username: 'x' }),
  norm('ntfy', { url: 'https://new.test', webhookUrl: 'https://old.test' }),
  norm('ntfy', { url: '', webhookUrl: 'https://old.test' }),
  norm('ntfy', { url: '  https://ntfy.example.com  ', topic: ' media ', nested: { a: ' x ' }, n: 3 }),
  norm('webhook', { url: 'https://h.test' }),
  norm('webhook', { url: 'https://h.test', other: ' keep ', arr: [' a '] }),
  norm('gotify', { url: 'https://g.test' }),
  norm('gotify', { url: 'https://g.test', token: '' }),
  norm('gotify', { url: 'https://g.test', token: '   ' }),
  norm('gotify', { url: 'https://g.test', token: null }, { token: 'stored' }),
  norm('gotify', { url: 'https://g.test', token: ' abc ' }),
  norm('gotify', { url: 'https://g.test' }, { token: 'stored' }),
  norm('gotify', { url: 'https://g.test', token: '' }, { token: 'stored' }),
  norm('ntfy', { url: 'https://n.test' }, { token: 'stored' }),
  norm('ntfy', { url: 'https://n.test', token: '' }, { token: 'stored' }),
  norm('ntfy', { url: 'https://n.test', token: '  ' }, { token: 'stored' }),
  norm('ntfy', { url: 'https://n.test', token: null }, { token: 'stored' }),
  norm('ntfy', { url: 'https://n.test', token: 'new' }, { token: 'stored' }),
  norm('ntfy', { url: 'https://n.test', token: 0 }, { token: 'stored' }),
  norm('ntfy', { url: 'https://n.test', secretsSet: ['token'] }),
  norm('ntfy', { url: 'https://n.test', secretsSet: ['token'] }, { token: 'stored' }),
  norm('discord', { webhookUrl: 'https://d.test', secretsSet: ['token'] }),
  norm('slack', { webhookUrl: 'https://s.test', token: ' t ' }),
  norm('webhook', { url: 'https://h.test', token: null }),
  norm('ntfy', {}),
  norm('gotify', {}),
  norm('ntfy', { webhookUrl: null }),
);

// validate
const ok = { name: 'n', type: 'ntfy', settings: { url: 'https://n.test' } };
inputs.push(
  val(ok),
  val({ ...ok, events: [], enabled: false }),
  val({ ...ok, settings: {} }),
  val({ ...ok, settings: { url: '' } }),
  val({ ...ok, settings: { url: '   ' } }),
  val({ ...ok, settings: { url: 'ntfy.example.com' } }),
  val({ ...ok, settings: { url: 'ftp://x' } }),
  val({ ...ok, settings: { url: 'HTTPS://X.TEST' } }),
  val({ ...ok, settings: { url: ' https://x.test ' } }),
  val({ ...ok, settings: { url: 5 } }),
  val({ ...ok, settings: { webhookUrl: 'https://legacy.test' } }),
  val({ ...ok, settings: { url: 'https://n.test', webhookUrl: 'nope' } }),
  val({ ...ok, settings: { url: 'nope', webhookUrl: 'https://legacy.test' } }),
  val({ ...ok, settings: { url: '', webhookUrl: 'https://legacy.test' } }),
  val({ name: 'd', type: 'discord', settings: { webhookUrl: 'https://d.test' } }),
  val({ name: 'd', type: 'discord', settings: { url: 'https://d.test' } }),
  val({ name: 'd', type: 'discord', settings: {} }),
  val({ name: 's', type: 'slack', settings: { webhookUrl: 'hook' } }),
  val({ name: 'w', type: 'webhook', settings: { url: 'http://h.test' } }),
  val({ name: 'g', type: 'gotify', settings: { url: 'https://g.test' } }),
  val({ ...ok, type: 'teams' }),
  val({ ...ok, type: 5 }),
  val({ ...ok, type: undefined }),
  val({ ...ok, name: 5 }),
  val({ ...ok, name: undefined }),
  val({ ...ok, name: '' }),
  val({ ...ok, settings: 'x' }),
  val({ ...ok, settings: null }),
  val({ ...ok, settings: [] }),
  val({ ...ok, settings: undefined }),
  val({ ...ok, events: 'request.created' }),
  val({ ...ok, events: ['request.created', 'nope'] }),
  val({ ...ok, events: [5] }),
  val({ ...ok, events: null }),
  val({ ...ok, events: 'nope' }),
  val({ ...ok, events: 5 }),
  val({ ...ok, events: {} }),
  val({ ...ok, events: true }),
  val({ ...ok, events: [] }),
  val({ ...ok, settings: 5 }),
  val({ name: 'd', type: 'discord', settings: { webhookUrl: '  ' } }),
  val({ name: 'd', type: 'discord', settings: { webhookUrl: null } }),
  val({ ...ok, enabled: 'yes' }),
  val({ ...ok, enabled: 0 }),
  val({ ...ok, enabled: null }),
  val({ ...ok, extra: 1 }),
  val({ ...ok, id: 3 }),
  val({ ...ok, name: 5, extra: 1, other: 2 }),
  val({ ...ok, type: 'teams', extra: 1 }),
  val({ ...ok, type: 'teams', settings: {}, events: ['x'], enabled: 1 }),
  val({}),
  ...NOTIFICATION_EVENTS.map((e) => val({ ...ok, events: [e] })),
  val({ ...ok, events: [...NOTIFICATION_EVENTS] }),
  val({ ...ok, events: [...SUBSCRIBABLE_NOTIFICATION_EVENTS] }),
  { fn: 'subscribable' },
);

// redact
inputs.push(
  redact('ntfy', { url: 'https://n.test', topic: 't', token: 'tk' }),
  redact('ntfy', { url: 'https://n.test' }),
  redact('ntfy', { url: 'https://n.test', token: '' }),
  redact('ntfy', {}),
  redact('webhook', { url: 'https://h.test', token: 'tk', secretsSet: ['x'] }),
  redact('gotify', { url: 'https://g.test', token: 'tok', extra: { a: 1 } }),
  redact('webhook', { url: 'https://h.test', webhookUrl: 'https://legacy.test', token: null }),
);

async function run(i: any): Promise<unknown> {
  switch (i.fn) {
    case 'send': {
      sent = undefined;
      try {
        await service.send({ name: 'c', type: i.type, settings: i.settings, events: [i.event], enabled: true }, i.event, i.payload);
      } catch (e) {
        return { error: (e as Error).message };
      }
      return sent ? { url: sent.url, headers: sent.headers, body: sent.body } : { sent: false };
    }
    case 'format':
      return { message: service.formatMessage(i.event, i.payload) };
    case 'normalize':
      try {
        return { settings: JSON.parse(JSON.stringify(service.normalizeSettings(i.type, i.settings, i.existing))) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    case 'validate': {
      const errors = await validate(plainToInstance(CreateNotificationConnectionDto, i.body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      return { errors: errors.flatMap((e) => Object.values(e.constraints ?? {})) };
    }
    case 'redact':
      return { settings: redactNotificationSecrets({ settings: i.settings } as never).settings };
    case 'subscribable':
      return { events: [...SUBSCRIBABLE_NOTIFICATION_EVENTS] };
  }
}

emit('notifications', inputs, run).then(() => console.log(`notifications ${inputs.length}`));
