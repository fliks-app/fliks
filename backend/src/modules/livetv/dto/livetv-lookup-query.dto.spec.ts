import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  LiveTvOnNowQueryDto,
  LiveTvMatchReportQueryDto,
  LiveTvSearchQueryDto,
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

  // A megabyte-long `q` used to reach the database in an unbounded ILIKE.
  it('rejects a query over 200 characters', async () => {
    expect(await check(LiveTvOnNowQueryDto, { query: 'a'.repeat(201) })).not.toEqual([]);
  });

  it('accepts a query at exactly 200 characters', async () => {
    expect(await check(LiveTvOnNowQueryDto, { query: 'a'.repeat(200) })).toEqual([]);
  });

  // The service already clamps to 50 internally; the DTO must say so too.
  it('rejects a pageSize above the server-side cap', async () => {
    expect(await check(LiveTvOnNowQueryDto, { pageSize: '51' })).not.toEqual([]);
  });

  it('accepts pageSize at the cap', async () => {
    expect(await check(LiveTvOnNowQueryDto, { pageSize: '50' })).toEqual([]);
  });
});

describe('LiveTvSearchQueryDto', () => {
  it('rejects a q over 200 characters', async () => {
    expect(await check(LiveTvSearchQueryDto, { q: 'a'.repeat(201) })).not.toEqual([]);
  });

  it('accepts a short q', async () => {
    expect(await check(LiveTvSearchQueryDto, { q: 'bbc' })).toEqual([]);
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
