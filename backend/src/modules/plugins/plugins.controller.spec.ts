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

  it('delegates setEnabled to the install service with the parsed body', async () => {
    const summary = { pluginId: 'fliks.test-plugin', status: 'active' };
    const installService = { setEnabled: jest.fn().mockResolvedValue(summary) };
    const controller = new PluginsController(installService as never);

    await expect(controller.setEnabled('fliks.test-plugin', { enabled: false })).resolves.toBe(summary);
    expect(installService.setEnabled).toHaveBeenCalledWith('fliks.test-plugin', false);
  });

  it('delegates restart to the install service', async () => {
    const installService = { restart: jest.fn().mockResolvedValue(undefined) };
    const controller = new PluginsController(installService as never);

    await expect(controller.restart('fliks.test-plugin')).resolves.toBeUndefined();
    expect(installService.restart).toHaveBeenCalledWith('fliks.test-plugin');
  });
});
