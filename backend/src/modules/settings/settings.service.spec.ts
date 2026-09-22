import { BadRequestException } from '@nestjs/common';
import { OWN_MODULE_ORIGIN, SettingsService } from './settings.service';

describe('SettingsService', () => {
  let rows: Record<string, string | null>;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let events: { emitDomain: jest.Mock };
  let service: SettingsService;

  beforeEach(() => {
    rows = {};
    repo = {
      findOne: jest.fn(({ where: { key } }: { where: { key: string } }) =>
        Promise.resolve(key in rows ? { key, value: rows[key] } : null),
      ),
      create: jest.fn((row: { key: string; value: string | null }) => ({
        ...row,
      })),
      save: jest.fn((row: { key: string; value: string | null }) => {
        rows[row.key] = row.value;
        return Promise.resolve(row);
      }),
    };
    events = { emitDomain: jest.fn() };
    service = new SettingsService(repo as never, events as never);
  });

  it.each([
    'livetv_restricted_groups',
    'livetv_restricted_groups_exempt',
    'livetv_restricted_groups_vanished',
  ])('refuses to write "%s" via the generic path', async (key) => {
    await expect(service.set(key, '[]')).rejects.toThrow(BadRequestException);
    expect(rows[key]).toBeUndefined();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('names the owning endpoint in the error', async () => {
    await expect(service.set('livetv_restricted_groups', '[]')).rejects.toThrow(
      /livetv\/admin\/access\/restricted-groups/,
    );
  });

  it('lets the owning module write a protected key via its bypass origin', async () => {
    await service.set('livetv_restricted_groups', '["X"]', OWN_MODULE_ORIGIN);
    expect(rows.livetv_restricted_groups).toBe('["X"]');
  });

  it('writes an ordinary key with no origin at all', async () => {
    await service.set('naming_movie_format', '{Movie.Title}');
    expect(rows.naming_movie_format).toBe('{Movie.Title}');
  });
});
