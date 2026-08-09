import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { PluginLogoController } from './plugin-logo.controller';
import { buildZip } from './archive/zip-builder';
import { pngLogo, svgLogo } from './archive/test-fixtures';
import type { RegisteredPlugin } from './plugin-registry.service';

function fakeResponse(): jest.Mocked<Pick<Response, 'set' | 'send'>> {
  return { set: jest.fn(), send: jest.fn() } as never;
}

function registryReturning(plugin: Pick<RegisteredPlugin, 'archive'> | undefined) {
  return { get: jest.fn().mockReturnValue(plugin) };
}

describe('PluginLogoController', () => {
  it('serves a PNG logo with the sniffed content type and the security headers', async () => {
    const logo = pngLogo();
    const archive = buildZip([{ name: 'logo.png', content: logo }]);
    const controller = new PluginLogoController(registryReturning({ archive }) as never);
    const res = fakeResponse();

    await controller.logo('fliks.test-plugin', res as never);

    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    expect(res.send).toHaveBeenCalledWith(logo);
  });

  it('serves a clean SVG logo as image/svg+xml', async () => {
    const archive = buildZip([{ name: 'logo.svg', content: svgLogo() }]);
    const controller = new PluginLogoController(registryReturning({ archive }) as never);
    const res = fakeResponse();

    await controller.logo('fliks.test-plugin', res as never);

    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Content-Type': 'image/svg+xml' }),
    );
  });

  it('refuses an SVG entry carrying a <script> element instead of serving it', async () => {
    const malicious = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    );
    const archive = buildZip([{ name: 'logo.svg', content: malicious }]);
    const controller = new PluginLogoController(registryReturning({ archive }) as never);

    await expect(controller.logo('fliks.test-plugin', fakeResponse() as never)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404s for an unregistered plugin id without reading any archive', async () => {
    const registry = registryReturning(undefined);
    const controller = new PluginLogoController(registry as never);

    await expect(controller.logo('unknown', fakeResponse() as never)).rejects.toThrow(NotFoundException);
    expect(registry.get).toHaveBeenCalledWith('unknown');
  });
});
