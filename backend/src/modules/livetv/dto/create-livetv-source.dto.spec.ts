import * as path from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLiveTvSourceDto } from './create-livetv-source.dto';
import { playlistDir } from '../services/livetv-playlist-file';

/** Mirrors the global pipe (whitelist + forbidNonWhitelisted) from main.ts. */
const check = async (payload: Record<string, unknown>) => {
  const dto = plainToInstance(CreateLiveTvSourceDto, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

const base = { name: 'Provider', kind: 'm3u' as const };

describe('CreateLiveTvSourceDto url', () => {
  it('accepts a fetchable URL', async () => {
    expect(await check({ ...base, url: 'http://provider.example/playlist.m3u' })).toEqual([]);
  });

  it('accepts the path returned by the playlist upload endpoint', async () => {
    const uploaded = path.join(playlistDir(), 'provider-list-abc123.m3u');
    expect(await check({ ...base, url: uploaded })).toEqual([]);
  });

  it('rejects an arbitrary local path (no local-file read oracle)', async () => {
    expect(await check({ ...base, url: '/etc/shadow' })).not.toEqual([]);
  });

  it('rejects a non-URL string', async () => {
    expect(await check({ ...base, url: 'not a url' })).not.toEqual([]);
  });
});
