import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  LiveTvOnNowQueryDto,
  LiveTvMatchReportQueryDto,
} from './livetv-lookup-query.dto';

/** Mirrors the global pipe (whitelist + forbidNonWhitelisted + transform) from main.ts. */
const check = async <T extends object>(cls: new () => T, payload: Record<string, unknown>) => {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('LiveTvOnNowQueryDto', () => {
  it('accepts a plain page/pageSize/group/query payload', async () => {
    expect(
      await check(LiveTvOnNowQueryDto, { page: '2', pageSize: '10', group: 'News', query: 'bbc' }),
    ).toEqual([]);
  });

  it('accepts an empty payload: every field is optional', async () => {
    expect(await check(LiveTvOnNowQueryDto, {})).toEqual([]);
  });

  // Unguarded `Number.parseInt('0')` used to become `OFFSET -50` at the database.
  it('rejects page=0', async () => {
    expect(await check(LiveTvOnNowQueryDto, { page: '0' })).not.toEqual([]);
  });

  // Unguarded `Number.parseInt('abc')` used to become NaN reaching the query.
  it('rejects a non-numeric page', async () => {
    expect(await check(LiveTvOnNowQueryDto, { page: 'abc' })).not.toEqual([]);
  });

  it('rejects a non-numeric pageSize', async () => {
    expect(await check(LiveTvOnNowQueryDto, { pageSize: 'abc' })).not.toEqual([]);
  });
});

describe('LiveTvMatchReportQueryDto', () => {
  it('accepts a numeric guideSourceId', async () => {
    expect(await check(LiveTvMatchReportQueryDto, { guideSourceId: '3' })).toEqual([]);
  });

  it('accepts no guideSourceId at all', async () => {
    expect(await check(LiveTvMatchReportQueryDto, {})).toEqual([]);
  });

  it('rejects a non-numeric guideSourceId', async () => {
    expect(await check(LiveTvMatchReportQueryDto, { guideSourceId: 'abc' })).not.toEqual([]);
  });
});
