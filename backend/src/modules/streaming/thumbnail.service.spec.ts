import { ThumbnailService } from './thumbnail.service';

describe('ThumbnailService.deleteForFile', () => {
  it('drops the engine sprites of the file', async () => {
    const invalidate = jest.fn().mockResolvedValue(undefined);
    await new ThumbnailService({ invalidate } as never).deleteForFile(4);
    expect(invalidate).toHaveBeenCalledWith(4);
  });
});
