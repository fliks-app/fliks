import { PluginsController } from './plugins.controller';

describe('PluginsController', () => {
  it('delegates uninstall to the install service', async () => {
    const installService = { uninstall: jest.fn().mockResolvedValue(undefined) };
    const controller = new PluginsController(installService as never);

    await expect(controller.uninstall('fliks.test-plugin')).resolves.toBeUndefined();
    expect(installService.uninstall).toHaveBeenCalledWith('fliks.test-plugin');
  });

  it('delegates list to the install service', async () => {
    const rows = [{ pluginId: 'fliks.test-plugin', status: 'active' }];
    const installService = { listInstalled: jest.fn().mockResolvedValue(rows) };
    const controller = new PluginsController(installService as never);

    await expect(controller.list()).resolves.toBe(rows);
    expect(installService.listInstalled).toHaveBeenCalled();
  });


  it('delegates restart to the install service', async () => {
    const installService = { restart: jest.fn().mockResolvedValue(undefined) };
    const controller = new PluginsController(installService as never);

    await expect(controller.restart('fliks.test-plugin')).resolves.toBeUndefined();
    expect(installService.restart).toHaveBeenCalledWith('fliks.test-plugin');
  });

  it('delegates disable to the install service', async () => {
    const summary = { pluginId: 'fliks.test-plugin', enabled: false };
    const installService = { disable: jest.fn().mockResolvedValue(summary) };
    const controller = new PluginsController(installService as never);

    await expect(controller.disable('fliks.test-plugin')).resolves.toBe(summary);
    expect(installService.disable).toHaveBeenCalledWith('fliks.test-plugin');
  });

  it('delegates enable to the install service', async () => {
    const summary = { pluginId: 'fliks.test-plugin', enabled: true };
    const installService = { enable: jest.fn().mockResolvedValue(summary) };
    const controller = new PluginsController(installService as never);

    await expect(controller.enable('fliks.test-plugin')).resolves.toBe(summary);
    expect(installService.enable).toHaveBeenCalledWith('fliks.test-plugin');
  });
});
