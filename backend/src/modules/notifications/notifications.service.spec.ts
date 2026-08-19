import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import axios from 'axios';
import { NotificationsService } from './notifications.service';
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
    findOne: () =>
      Promise.resolve({ id: 1, type: 'ntfy', settings: {}, events: [] }),
  };
  const service = new NotificationsService(repo as never);

  beforeEach(() => (saved.length = 0));

  it('folds a legacy webhookUrl onto url for server-addressed types', async () => {
    for (const type of ['webhook', 'gotify', 'ntfy']) {
      await service.create({
        name: type,
        type,
        settings: { webhookUrl: 'https://ntfy.example.com', topic: 'media' },
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

  it('requires a token for gotify', async () => {
    const errors = await check({
      name: 'Gotify',
      type: 'gotify',
      settings: { url: 'https://gotify.example.com' },
    });
    expect(errors).toContain(
      'gotify requires settings.url to be an http(s) URL and a non-empty settings.token',
    );
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

describe('NotificationsService ntfy dispatch', () => {
  const serviceFor = (settings: Record<string, unknown>) =>
    new NotificationsService({
      findOne: () =>
        Promise.resolve({ id: 1, type: 'ntfy', events: [], settings }),
    } as never);

  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({ status: 200 } as never);
  });

  it('falls back to the default topic when none is stored', async () => {
    await serviceFor({ url: 'https://ntfy.sh', topic: '' }).testConnection(1);
    expect(mockedAxios.post.mock.calls[0][0]).toBe('https://ntfy.sh/fliks');
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

  it('sends a bearer token on a generic webhook', async () => {
    const service = serviceFor({
      type: 'webhook',
      settings: { url: 'https://hook.example.com', token: 'wh_secret' },
    });

    await service.testConnection(1);
    expect(lastCall().headers.Authorization).toBe('Bearer wh_secret');
  });
});
