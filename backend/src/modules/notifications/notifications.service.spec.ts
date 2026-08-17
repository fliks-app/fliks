import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { NotificationsService } from './notifications.service';
import { CreateNotificationConnectionDto } from './dto/create-notification-connection.dto';

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
    expect(errors).toContain('ntfy requires a non-empty settings.url');
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
      'gotify requires a non-empty settings.url and settings.token',
    );
  });

  it('rejects a blank endpoint, which is what the editor used to save', async () => {
    const errors = await check({
      name: 'Ntfy',
      type: 'ntfy',
      settings: { webhookUrl: '   ' },
    });
    expect(errors).toContain('ntfy requires a non-empty settings.url');
  });
});
