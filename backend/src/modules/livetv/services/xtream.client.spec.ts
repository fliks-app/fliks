import axios from 'axios';
import { XtreamClient, detectXtreamFromUrl, pickOutputFormat } from './xtream.client';
import { UNGROUPED_SENTINEL } from '../parsing/group-name';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('pickOutputFormat', () => {
  it.each([
    [['m3u8', 'ts'], 'ts'],
    [['m3u8'], 'm3u8'],
    [[], 'ts'],
    [['hls', 'rtmp'], 'hls'],
  ])('%j -> %s', (allowed, expected) => {
    expect(pickOutputFormat(allowed)).toBe(expected);
  });
});

describe('detectXtreamFromUrl', () => {
  it('extracts credentials from a get.php playlist link', () => {
    expect(detectXtreamFromUrl('http://host:8080/get.php?username=u&password=p&type=m3u')).toEqual({
      baseUrl: 'http://host:8080',
      username: 'u',
      password: 'p',
    });
  });

  it('rejects a url with no recognisable panel path', () => {
    expect(detectXtreamFromUrl('http://host/live/u/p/1.ts')).toBeNull();
  });
});

describe('XtreamClient', () => {
  const creds = { baseUrl: 'http://host', username: 'u', password: 'p' };

  afterEach(() => jest.resetAllMocks());

  it('reads allowed_output_formats off the account and lower-cases them', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        user_info: {
          auth: 1,
          status: 'Active',
          exp_date: '1893456000',
          max_connections: '3',
          active_cons: '1',
          allowed_output_formats: ['M3U8', 'TS'],
        },
      },
    });
    const account = await new XtreamClient(creds).account();
    expect(account.allowedOutputFormats).toEqual(['m3u8', 'ts']);
    expect(account.maxConnections).toBe(3);
    expect(account.status).toBe('Active');
  });

  it('defaults allowedOutputFormats to empty when the panel omits it', async () => {
    mockedAxios.get.mockResolvedValue({ data: { user_info: { auth: 1 } } });
    const account = await new XtreamClient(creds).account();
    expect(account.allowedOutputFormats).toEqual([]);
  });

  it('rejects when the panel refuses authentication', async () => {
    mockedAxios.get.mockResolvedValue({ data: { user_info: { auth: 0 } } });
    await expect(new XtreamClient(creds).account()).rejects.toThrow('authentication refused');
  });

  it('carries direct_source through liveStreams for streamUrl to be skipped', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: [{ category_id: '1', category_name: 'News' }] })
      .mockResolvedValueOnce({
        data: [
          { stream_id: 1, name: 'One', category_id: '1', direct_source: 'http://cdn/one.m3u8' },
          { stream_id: 2, name: 'Two', category_id: '1' },
        ],
      });
    const streams = await new XtreamClient(creds).liveStreams();
    expect(streams[0].directSource).toBe('http://cdn/one.m3u8');
    expect(streams[1].directSource).toBeNull();
  });

  it('trims a padded category name and sentinels a missing one', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        data: [
          { category_id: '1', category_name: '  XXX  ' },
          { category_id: '2', category_name: '' },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { stream_id: 1, name: 'One', category_id: '1' },
          { stream_id: 2, name: 'Two', category_id: '2' },
          { stream_id: 3, name: 'Three' },
        ],
      });
    const streams = await new XtreamClient(creds).liveStreams();
    expect(streams[0].categoryName).toBe('XXX');
    expect(streams[1].categoryName).toBe(UNGROUPED_SENTINEL);
    expect(streams[2].categoryName).toBe(UNGROUPED_SENTINEL);
  });

  it('builds the stream url with the chosen format', () => {
    const url = new XtreamClient(creds).streamUrl('42', 'ts');
    expect(url).toBe('http://host/live/u/p/42.ts');
  });

  it('carries the shared response-size limit through the panel call', async () => {
    mockedAxios.get.mockResolvedValue({ data: { user_info: { auth: 1 } } });

    await new XtreamClient(creds).account();

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maxContentLength: 512 * 1024 * 1024,
        maxBodyLength: 512 * 1024 * 1024,
      }),
    );
  });
});
