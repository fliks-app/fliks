import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DeviceProfileDto } from './device-profile.dto';

/** Mirrors the global pipe (whitelist + forbidNonWhitelisted) from main.ts. */
const check = async (extra: Record<string, unknown>) => {
  const dto = plainToInstance(DeviceProfileDto, {
    directPlayProfiles: [
      { containers: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'] },
    ],
    ...extra,
  });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

describe('DeviceProfileDto needsHlsSubtitles', () => {
  it('is optional', async () => {
    expect((await check({})).errors).toHaveLength(0);
  });

  it('accepts a boolean and keeps it through the whitelist', async () => {
    const { dto, errors } = await check({ needsHlsSubtitles: true });
    expect(errors).toHaveLength(0);
    expect(dto.needsHlsSubtitles).toBe(true);
  });

  it('rejects a non-boolean', async () => {
    const { errors } = await check({ needsHlsSubtitles: 'yes' });
    expect(errors.map((e) => e.property)).toContain('needsHlsSubtitles');
  });
});
