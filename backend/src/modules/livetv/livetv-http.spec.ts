import axios from 'axios';
import * as dns from 'dns';
import { assertNotInternal, liveTvGet } from './livetv-http';

jest.mock('axios');
jest.mock('dns', () => ({ promises: { lookup: jest.fn() } }));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const lookupMock = jest.mocked(dns.promises.lookup);

describe('assertNotInternal', () => {
  beforeEach(() => lookupMock.mockReset());

  it('refuses a host that resolves to an internal address', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);

    await expect(assertNotInternal('http://metadata.internal/x')).rejects.toThrow(
      /internal address/,
    );
  });

  it('allows a host that resolves to a public address', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);

    await expect(assertNotInternal('http://provider.example/x')).resolves.toBeUndefined();
  });

  it('refuses when the host fails to resolve at all', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(assertNotInternal('http://nowhere.invalid/x')).rejects.toThrow(
      /Could not resolve/,
    );
  });
});

describe('liveTvGet', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({ status: 200, data: 'ok', headers: {} });
    lookupMock.mockReset();
  });

  it('bounds the response size', async () => {
    await liveTvGet('http://provider.example/playlist.m3u', {});

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://provider.example/playlist.m3u',
      expect.objectContaining({
        maxContentLength: 512 * 1024 * 1024,
        maxBodyLength: 512 * 1024 * 1024,
      }),
    );
  });

  it('never resolves DNS itself: a registered source may target the LAN', async () => {
    await liveTvGet('http://192.168.1.50/playlist.m3u', {});

    expect(mockedAxios.get).toHaveBeenCalledWith('http://192.168.1.50/playlist.m3u', expect.anything());
    expect(dns.promises.lookup).not.toHaveBeenCalled();
  });
});
