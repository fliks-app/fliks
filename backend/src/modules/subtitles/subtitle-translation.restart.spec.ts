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

  it('leaves no progress behind once a run ends', async () => {
    const { service } = build(jest.fn().mockResolvedValue({ affected: 1 }));

    await (
      service as never as { runTranslation: (...a: unknown[]) => Promise<void> }
    ).runTranslation(42, { id: 7, mediaId: 1, language: 'en' }, 'fr', { engine: 'gemini' }, 1);

    expect(service.progressFor(42)).toBeUndefined();
  });
});
