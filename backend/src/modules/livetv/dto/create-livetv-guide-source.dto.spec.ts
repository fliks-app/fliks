import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLiveTvGuideSourceDto } from './create-livetv-guide-source.dto';

const check = async (payload: Record<string, unknown>) => {
  const dto = plainToInstance(CreateLiveTvGuideSourceDto, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('CreateLiveTvGuideSourceDto url', () => {
  it('accepts a fetchable URL', async () => {
    expect(
      await check({ name: 'Guide', kind: 'xmltv', url: 'http://provider.example/guide.xml' }),
    ).toEqual([]);
  });

  it('accepts a missing url (kind: source reads its live source)', async () => {
    expect(await check({ name: 'Guide', kind: 'source', sourceId: 1 })).toEqual([]);
  });

  it('rejects a local path — a guide feed is always fetched over HTTP', async () => {
    expect(await check({ name: 'Guide', kind: 'xmltv', url: '/etc/passwd' })).not.toEqual([]);
  });
});
