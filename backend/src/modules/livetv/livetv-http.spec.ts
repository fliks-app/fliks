import axios from 'axios';
import * as dns from 'dns';
import { liveTvGet } from './livetv-http';

jest.mock('axios');
jest.mock('dns', () => ({ promises: { lookup: jest.fn() } }));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const lookupMock = jest.mocked(dns.promises.lookup);

describe('liveTvGet', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({ status: 200, data: 'ok', headers: {} });
  });

  it('refuses a host that resolves to an internal address', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);

    await expect(liveTvGet('http://metadata.internal/x', {})).rejects.toThrow(/internal address/);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('proceeds for a host that resolves to a public address, bounding the response size', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);

    await liveTvGet('http://provider.example/playlist.m3u', {});

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://provider.example/playlist.m3u',
      expect.objectContaining({
        maxContentLength: 512 * 1024 * 1024,
        maxBodyLength: 512 * 1024 * 1024,
      }),
    );
  });

  it('refuses when the host fails to resolve at all', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(liveTvGet('http://nowhere.invalid/x', {})).rejects.toThrow(/Could not resolve/);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
