import { BadRequestException } from '@nestjs/common';
import { ImportsController } from './imports.controller';

function make(stored: string | null) {
  const radarr = { testConnection: jest.fn(), previewRootFolders: jest.fn() };
  const sonarr = { importFromApi: jest.fn() };
  const seerr = { testConnection: jest.fn() };
  const settings = { get: jest.fn().mockResolvedValue(stored) };
  const ctrl = new ImportsController(
    radarr as never,
    sonarr as never,
    seerr as never,
    {} as never,
    {} as never,
    {} as never,
    settings as never,
    {} as never,
  );
  return { ctrl, radarr, sonarr, seerr, settings };
}

describe('ImportsController api key fallback', () => {
  it('uses the provided key without reading settings', async () => {
    const { ctrl, radarr, settings } = make('stored');
    await ctrl.testRadarrConnection({ url: 'http://r', apiKey: 'typed' });
    expect(radarr.testConnection).toHaveBeenCalledWith('http://r', 'typed');
    expect(settings.get).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '  '])('falls back to the stored key for %p', async (k) => {
    const { ctrl, radarr, settings } = make('stored');
    await ctrl.previewRadarr({ url: 'http://r', apiKey: k });
    expect(settings.get).toHaveBeenCalledWith('radarr_api_key');
    expect(radarr.previewRootFolders).toHaveBeenCalledWith('http://r', 'stored');
  });

  it('uses the sonarr and seerr setting keys', async () => {
    const { ctrl, sonarr, seerr, settings } = make('stored');
    await ctrl.importSonarrApi({ url: 'http://s' } as never);
    expect(settings.get).toHaveBeenCalledWith('sonarr_api_key');
    expect(sonarr.importFromApi.mock.calls[0][1]).toBe('stored');
    await ctrl.testSeerr({ url: 'http://s' });
    expect(settings.get).toHaveBeenCalledWith('seerr_api_key');
    expect(seerr.testConnection).toHaveBeenCalledWith('http://s', 'stored');
  });

  it('rejects when nothing is provided or stored', async () => {
    const { ctrl } = make(null);
    await expect(ctrl.testSeerr({ url: 'http://s' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
