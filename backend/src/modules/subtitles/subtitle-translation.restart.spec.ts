import { ConflictException } from '@nestjs/common';
import {
  SubtitleTranslationService,
  mergeTranslated,
  translationErrorMessage,
} from './subtitle-translation.service';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import {
  TranslationPayloadTooLargeError,
  TranslationRateLimitError,
  parseNumbered,
} from './translation-core';

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
      { get: jest.fn().mockResolvedValue('false') } as never,
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

  it('keys the duplicate-run guard on the hearingImpaired value the filename will actually use', async () => {
    const source = {
      id: 7,
      mediaId: 1,
      mediaFileId: 3,
      episodeId: null,
      language: 'en',
      relativePath: 'a.srt',
      forced: false,
      hearingImpaired: true,
    };
    const findOne = jest
      .fn()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ id: 99, status: SubtitleStatus.PROCESSING });
    const service = new SubtitleTranslationService(
      { findOne, save: jest.fn() } as never,
      {} as never,
      // subtitle_remove_hi_tags enabled: the output filename drops the .hi
      // suffix, so a hi and a non-hi source now target the same file.
      { get: jest.fn().mockResolvedValue('true') } as never,
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

    const guardWhere = findOne.mock.calls[1][0].where;
    expect(guardWhere.hearingImpaired).toBe(false);
  });

  it('leaves no progress behind once a run ends', async () => {
    const { service } = build(jest.fn().mockResolvedValue({ affected: 1 }));
    (service as never as { progress: Map<number, number> }).progress.set(42, 0);

    await (
      service as never as { runTranslation: (...a: unknown[]) => Promise<void> }
    ).runTranslation(42, { id: 7, mediaId: 1, language: 'en' }, 'fr', { engine: 'gemini' }, 1);

    expect(service.progressFor(42)).toBeUndefined();
  });

  it('keeps the source cue when the model answers a marker with nothing', () => {
    const translated = parseNumbered('#1#\nbonjour\n#2#\n#3#\nsalut', 3)!;
    expect(translated).toEqual(['bonjour', '', 'salut']);

    const cues = ['s1', 's2', 's3'];
    expect(cues.map((c, i) => mergeTranslated(c, translated[i]))).toEqual([
      'bonjour',
      's2',
      'salut',
    ]);
  });

  it('stores a translation key for a recognised engine failure, the raw cause otherwise', () => {
    expect(translationErrorMessage(new TranslationRateLimitError('x'))).toBe(
      'errors.translation_rate_limited',
    );
    expect(
      translationErrorMessage(new TranslationRateLimitError('x', 'daily')),
    ).toBe('errors.translation_rate_limited_daily');
    expect(translationErrorMessage(new TranslationPayloadTooLargeError('x'))).toBe(
      'errors.translation_too_large',
    );
    expect(translationErrorMessage(new Error('boom'))).toBe('Error: boom');
  });
});
