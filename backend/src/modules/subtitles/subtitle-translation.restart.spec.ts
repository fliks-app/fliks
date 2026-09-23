import { ConflictException } from '@nestjs/common';
import { SubtitleTranslationService } from './subtitle-translation.service';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';

function build(update = jest.fn().mockResolvedValue({ affected: 2 })) {
  const service = new SubtitleTranslationService(
    { update } as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    { get: jest.fn() } as never,
    { emit: jest.fn() } as never,
    { get: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  return { service, update };
}

/** A translation run lives in this process: nothing it left in the database is
 *  still true after a restart, and nothing it is doing now is visible to a
 *  client that was not listening. */
describe('SubtitleTranslationService — run state across restarts and clients', () => {
  it('fails every PROCESSING translation row at boot', async () => {
    const { service, update } = build();

    await service.onModuleInit();

    const [where, patch] = update.mock.calls[0];
    expect(where).toEqual({
      providerType: SubtitleProviderType.TRANSLATED,
      status: SubtitleStatus.PROCESSING,
    });
    expect(patch.status).toBe(SubtitleStatus.FAILED);
    expect(patch.errorMessage).toBe('activity.subtitle_error_interrupted');
  });

  it('refuses a second run for a track one is already translating', async () => {
    const source = {
      id: 7,
      mediaId: 1,
      mediaFileId: 3,
      episodeId: null,
      language: 'en',
      relativePath: 'a.srt',
      forced: false,
      hearingImpaired: false,
    };
    const findOne = jest
      .fn()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ id: 99, status: SubtitleStatus.PROCESSING });
    const save = jest.fn();
    const service = new SubtitleTranslationService(
      { findOne, save } as never,
      {} as never,
      {} as never,
      { emit: jest.fn() } as never,
      { get: jest.fn().mockResolvedValue({ enabled: true, maxConcurrency: 1 }) } as never,
      {
        findDefault: jest
          .fn()
          .mockResolvedValue({ id: 1, name: 'LT', engine: 'libretranslate', settings: {} }),
      } as never,
      { validateConfig: jest.fn(), resolveModel: jest.fn() } as never,
    );

    await expect(service.translateSubtitle(7, 'fr')).rejects.toThrow(ConflictException);
    expect(save).not.toHaveBeenCalled();
  });

  it('leaves no progress behind once a run ends', async () => {
    const { service } = build(jest.fn().mockResolvedValue({ affected: 1 }));

    await (
      service as never as { runTranslation: (...a: unknown[]) => Promise<void> }
    ).runTranslation(42, { id: 7, mediaId: 1, language: 'en' }, 'fr', { engine: 'gemini' }, 1);

    expect(service.progressFor(42)).toBeUndefined();
  });
});
