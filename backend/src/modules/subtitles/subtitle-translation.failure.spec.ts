import { SubtitleTranslationService } from './subtitle-translation.service';
import { SubtitleStatus } from '../../common/enums';

/** The placeholder row is the only record a failed run leaves in the database,
 *  and the activity page opens the cause it carries. */
describe('SubtitleTranslationService — what a failed run leaves behind', () => {
  const run = async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const del = jest.fn();
    const service = new SubtitleTranslationService(
      { update, delete: del } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { get: jest.fn() } as never,
      { emit: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await (service as never as {
      runTranslation: (...args: unknown[]) => Promise<void>;
    }).runTranslation(42, { id: 7, mediaId: 1, language: 'en' }, 'fr', { engine: 'gemini' }, 1);
    return { update, del };
  };

  it('marks the placeholder FAILED with the cause instead of deleting it', async () => {
    const { update, del } = await run();

    expect(del).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const [id, patch] = update.mock.calls[0];
    expect(id).toBe(42);
    expect(patch.status).toBe(SubtitleStatus.FAILED);
    expect(patch.errorMessage).toContain('media root folder not set');
  });
});
