import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import axios from 'axios';
import {
  NotificationsService,
  SUBSCRIBABLE_NOTIFICATION_EVENTS,
  redactNotificationSecrets,
} from './notifications.service';
import { NOTIFICATION_EVENTS } from './entities/notification-connection.entity';
import { NotificationsController } from './notifications.controller';
import { CreateNotificationConnectionDto } from './dto/create-notification-connection.dto';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

describe('NotificationsService settings normalization', () => {
  const saved: Record<string, unknown>[] = [];
  const repo = {
    create: (row: Record<string, unknown>) => row,
    save: (row: Record<string, unknown>) => {
      saved.push(row);
      return Promise.resolve({ id: 1, ...row });
    },
    findOne: () => Promise.resolve({ id: 1, events: [], ...stored }),
  };
  const service = new NotificationsService(repo as never);
  let stored: { type: string; settings: Record<string, unknown> };

  beforeEach(() => {
    saved.length = 0;
    stored = { type: 'ntfy', settings: {} };
  });

  it('folds a legacy webhookUrl onto url for server-addressed types', async () => {
    for (const type of ['webhook', 'gotify', 'ntfy']) {
      await service.create({
        name: type,
        type,
        settings: {
          webhookUrl: 'https://ntfy.example.com',
          topic: 'media',
          token: 'tk',
        },
      });
    }
    for (const row of saved) {
      expect(row.settings).toMatchObject({ url: 'https://ntfy.example.com' });
      expect(row.settings).not.toHaveProperty('webhookUrl');
    }
  });

  it('leaves discord and slack on webhookUrl', async () => {
    await service.create({
      name: 'd',
      type: 'discord',
      settings: { webhookUrl: 'https://discord.test/hook' },
    });
    expect(saved[0].settings).toEqual({
      webhookUrl: 'https://discord.test/hook',
    });
  });

  it('keeps url authoritative when a row carries both keys', async () => {
    await service.create({
      name: 'n',
      type: 'ntfy',
      settings: { url: 'https://new.test', webhookUrl: 'https://old.test' },
    });
    expect(saved[0].settings).toEqual({ url: 'https://new.test' });
  });

  it('trims a pasted endpoint so axios can resolve it', async () => {
    await service.create({
      name: 'n',
      type: 'ntfy',
      settings: { url: '  https://ntfy.example.com  ', topic: ' media ' },
    });
    expect(saved[0].settings).toEqual({
      url: 'https://ntfy.example.com',
      topic: 'media',
    });
  });

  it('rejects a gotify connection with no token', async () => {
    await expect(
      service.create({
        name: 'Gotify',
        type: 'gotify',
        settings: { url: 'https://gotify.example.com' },
      }),
    ).rejects.toThrow('gotify requires a non-empty settings.token');
  });

  it('keeps the stored token when the editor saves a blank one', async () => {
    stored = {
      type: 'gotify',
      settings: { url: 'https://gotify.example.com', token: 'tk_stored' },
    };
    await service.update(1, {
      name: 'Gotify',
      type: 'gotify',
      settings: { url: 'https://gotify.example.com', token: '' },
    });
    expect(saved[0].settings).toEqual({
      url: 'https://gotify.example.com',
      token: 'tk_stored',
    });
  });

  it('erases the stored token when the editor sends an explicit null', async () => {
    stored = {
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', topic: 'media', token: 'tk_stored' },
    };
    await service.update(1, {
      name: 'Ntfy',
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', topic: 'media', token: null },
    });
    expect(saved[0].settings).toEqual({ url: 'https://ntfy.sh', topic: 'media' });
    expect(saved[0].settings).not.toHaveProperty('token');
  });

  it('refuses to erase a gotify token, since that connection cannot send without one', async () => {
    stored = {
      type: 'gotify',
      settings: { url: 'https://gotify.example.com', token: 'tk_stored' },
    };
    await expect(
      service.update(1, {
        name: 'Gotify',
        type: 'gotify',
        settings: { url: 'https://gotify.example.com', token: null },
      }),
    ).rejects.toThrow('gotify requires a non-empty settings.token');
  });

  it('never persists the read-only secretsSet marker the editor received', async () => {
    stored = {
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', token: 'tk_stored' },
    };
    await service.update(1, {
      name: 'Ntfy',
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', secretsSet: ['token'] },
    });
    expect(saved[0].settings).toEqual({ url: 'https://ntfy.sh', token: 'tk_stored' });
  });

  it('never persists the marker on discord either, which bypasses the token merge', async () => {
    await service.create({
      name: 'd',
      type: 'discord',
      settings: { webhookUrl: 'https://discord.test/hook', secretsSet: [] },
    });
    expect(saved[0].settings).toEqual({ webhookUrl: 'https://discord.test/hook' });
  });

  it('drops the stored token when the connection changes provider', async () => {
    stored = {
      type: 'gotify',
      settings: { url: 'https://gotify.example.com', token: 'tk_stored' },
    };
    await service.update(1, {
      name: 'Moved',
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', topic: 'media' },
    });
    expect(saved[0].settings).toEqual({
      url: 'https://ntfy.sh',
      topic: 'media',
    });
  });

  it('normalizes on update too', async () => {
    await service.update(1, {
      name: 'n',
      type: 'ntfy',
      settings: { webhookUrl: 'https://ntfy.example.com' },
    });
    expect(saved[0].settings).toEqual({ url: 'https://ntfy.example.com' });
  });
});

describe('CreateNotificationConnectionDto validation', () => {
  const check = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(CreateNotificationConnectionDto, payload);
    return (await validate(dto)).flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );
  };

  it('rejects an ntfy connection with no endpoint', async () => {
    const errors = await check({
      name: 'Ntfy',
      type: 'ntfy',
      settings: { topic: 'media' },
    });
    expect(errors).toContain('ntfy requires settings.url to be an http(s) URL');
  });

  it('accepts either the canonical or the legacy endpoint key', async () => {
    expect(
      await check({
        name: 'Ntfy',
        type: 'ntfy',
        settings: { url: 'https://ntfy.example.com' },
      }),
    ).toEqual([]);
    expect(
      await check({
        name: 'Ntfy',
        type: 'ntfy',
        settings: { webhookUrl: 'https://ntfy.example.com' },
      }),
    ).toEqual([]);
  });

  it('rejects a blank endpoint', async () => {
    const errors = await check({
      name: 'Ntfy',
      type: 'ntfy',
      settings: { webhookUrl: '   ' },
    });
    expect(errors).toContain('ntfy requires settings.url to be an http(s) URL');
  });

  it('rejects an endpoint with no scheme, which axios cannot resolve', async () => {
    const errors = await check({
      name: 'Ntfy',
      type: 'ntfy',
      settings: { url: 'ntfy.example.com' },
    });
    expect(errors).toContain('ntfy requires settings.url to be an http(s) URL');
  });
});

describe('notification event vocabulary', () => {
  const dtoErrors = async (events: string[]) => {
    const dto = plainToInstance(CreateNotificationConnectionDto, {
      name: 'n',
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh' },
      events,
    });
    return (await validate(dto)).flatMap((e) => Object.values(e.constraints ?? {}));
  };

  it('validates every event it dispatches — the subtitle four used to 400', async () => {
    expect(await dtoErrors([...NOTIFICATION_EVENTS])).toEqual([]);
  });

  it('still rejects an event nothing knows about', async () => {
    expect(await dtoErrors(['subtitle.teleported'])).not.toEqual([]);
  });

  it('declares GET events before GET :id, which is what keeps it off the ParseIntPipe', () => {
    const methods = Object.getOwnPropertyNames(NotificationsController.prototype);
    expect(methods.indexOf('events')).toBeLessThan(methods.indexOf('findOne'));
  });

  it('advertises everything something dispatches, and not the test-only one', async () => {
    expect(SUBSCRIBABLE_NOTIFICATION_EVENTS).not.toContain('health.issue');
    expect(SUBSCRIBABLE_NOTIFICATION_EVENTS).toHaveLength(NOTIFICATION_EVENTS.length - 1);
    // An advertised event has to be storable, or the editor offers a checkbox the API refuses.
    expect(await dtoErrors([...SUBSCRIBABLE_NOTIFICATION_EVENTS])).toEqual([]);
  });
});

describe('NotificationsService provider authentication', () => {
  const serviceFor = (row: Record<string, unknown>) =>
    new NotificationsService({
      findOne: () => Promise.resolve({ id: 1, events: [], ...row }),
    } as never);

  const lastCall = () => {
    const [url, body, config] = mockedAxios.post.mock.calls.at(-1) as [
      string,
      unknown,
      { headers?: Record<string, string> },
    ];
    return { url, body, headers: config?.headers ?? {} };
  };

  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({ status: 200 } as never);
  });

  it('renders a subtitle event as a sentence rather than dumping its payload', async () => {
    const service = new NotificationsService({
      find: () =>
        Promise.resolve([
          {
            id: 1,
            name: 'D',
            type: 'discord',
            enabled: true,
            events: ['subtitle.downloaded'],
            settings: { webhookUrl: 'https://discord.test/hook' },
          },
        ]),
    } as never);

    await service.dispatch('subtitle.downloaded', { title: 'Some Title', language: 'fr' });

    expect((lastCall().body as { content: string }).content).toBe('Subtitle downloaded: Some Title [fr]');
  });

  it('authenticates an ntfy push when a token is configured', async () => {
    const service = serviceFor({
      type: 'ntfy',
      settings: {
        url: 'https://ntfy.example.com',
        topic: 'media',
        token: 'tk_secret',
      },
    });

    await expect(service.testConnection(1)).resolves.toMatchObject({
      ok: true,
    });
    const { url, headers } = lastCall();
    expect(url).toBe('https://ntfy.example.com/media');
    expect(headers.Authorization).toBe('Bearer tk_secret');
  });

  it('omits the header entirely on a public ntfy topic', async () => {
    const service = serviceFor({
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', topic: 'media' },
    });

    await service.testConnection(1);
    expect(lastCall().headers).not.toHaveProperty('Authorization');
  });

  it('keeps the ntfy title ASCII so axios does not strip it', async () => {
    const service = serviceFor({
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', topic: 'media' },
    });

    await service.testConnection(1);
    const title = lastCall().headers.Title;
    expect(title).toBe('Fliks - health.issue');
    // eslint-disable-next-line no-control-regex
    expect(title).toMatch(/^[\x00-\x7F]*$/);
  });

  it('falls back to the default topic when none is stored', async () => {
    const service = serviceFor({
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', topic: '' },
    });

    await service.testConnection(1);
    expect(lastCall().url).toBe('https://ntfy.sh/fliks');
  });

  it('escapes the gotify token it puts in the query string', async () => {
    const service = serviceFor({
      type: 'gotify',
      settings: { url: 'https://gotify.example.com', token: 'a b&c' },
    });

    await service.testConnection(1);
    expect(lastCall().url).toBe(
      'https://gotify.example.com/message?token=a%20b%26c',
    );
  });

  it('sends a bearer token on a generic webhook', async () => {
    const service = serviceFor({
      type: 'webhook',
      settings: { url: 'https://hook.example.com', token: 'wh_secret' },
    });

    await service.testConnection(1);
    expect(lastCall().headers.Authorization).toBe('Bearer wh_secret');
  });
});

describe('redactNotificationSecrets', () => {
  it('strips the token but keeps the endpoint the editor has to show', () => {
    const conn = {
      id: 1,
      type: 'ntfy',
      settings: { url: 'https://ntfy.sh', topic: 'media', token: 'tk_secret' },
    };
    expect(redactNotificationSecrets(conn as never).settings).toEqual({
      url: 'https://ntfy.sh',
      topic: 'media',
      secretsSet: ['token'],
    });
  });

  it('reports no set secret when the connection stores none', () => {
    const conn = { id: 1, type: 'ntfy', settings: { url: 'https://ntfy.sh' } };
    expect(redactNotificationSecrets(conn as never).settings).toEqual({
      url: 'https://ntfy.sh',
      secretsSet: [],
    });
  });
});
