import { BadRequestException } from '@nestjs/common';
import { PluginImportController } from './plugin-import.controller';

describe('PluginImportController', () => {
  it('inspects the uploaded file and delegates to the install service', async () => {
    const installService = { inspectUpload: jest.fn().mockResolvedValue({ installable: true }) };
    const controller = new PluginImportController(installService as never);
    const file = { buffer: Buffer.from('archive bytes') } as Express.Multer.File;

    await expect(controller.inspect(file)).resolves.toEqual({ installable: true });
    expect(installService.inspectUpload).toHaveBeenCalledWith(file.buffer);
  });

  it('rejects when no file is uploaded, without touching the install service', async () => {
    const installService = { inspectUpload: jest.fn() };
    const controller = new PluginImportController(installService as never);

    await expect(controller.inspect(undefined as never)).rejects.toThrow(BadRequestException);
    expect(installService.inspectUpload).not.toHaveBeenCalled();
  });

  it('confirms an import by delegating to the install service', async () => {
    const result = { pluginId: 'fliks.test', version: '1.0.0', status: 'active' as const };
    const installService = { confirmImport: jest.fn().mockResolvedValue(result) };
    const controller = new PluginImportController(installService as never);
    const dto = { stagingId: 'a'.repeat(32), sha256: 'b'.repeat(64) };

    await expect(controller.confirm(dto)).resolves.toEqual(result);
    expect(installService.confirmImport).toHaveBeenCalledWith(dto);
  });
});
