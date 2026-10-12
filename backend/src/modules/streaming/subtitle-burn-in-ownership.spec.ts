import { NotFoundException } from '@nestjs/common';
import { SubtitleBurnInService } from './subtitle-burn-in.service';

describe('SubtitleBurnInService.resolve ownership', () => {
  it('rejects a subtitle that belongs to another media file', async () => {
    const resolveFile = jest.fn();
    const svc = Object.create(
      SubtitleBurnInService.prototype,
    ) as SubtitleBurnInService;
    Object.assign(svc, {
      subtitleFileRepo: {
        findOne: jest.fn().mockResolvedValue({ id: 7, mediaFileId: 2 }),
      },
      streamingService: { resolveFile },
    });
    await expect(svc.resolve(7, 1)).rejects.toThrow(NotFoundException);
    expect(resolveFile).not.toHaveBeenCalled();
  });
});
