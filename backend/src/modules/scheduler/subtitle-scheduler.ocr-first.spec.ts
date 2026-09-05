import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { SubtitleLanguageItem } from '../profiles/entities/language-profile.entity';

/**
 * A forced track holds only foreign dialogue. OCR'ing it to satisfy a request
 * for the full subtitle would store a ~40-line file under the plain language
 * tag, which then counts as servable and permanently closes the language.
 */
describe('SubtitleSchedulerService.tryOcrFirst — flag matching', () => {
  let ocrSubtitle: jest.Mock;

  function makeService() {
    ocrSubtitle = jest.fn().mockResolvedValue({ id: 1 });
    const service = new SubtitleSchedulerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dispatch: jest.fn() } as never,
      { get: () => Promise.resolve('true') } as never,
      {} as never,
      { ocrSubtitle } as never,
      { dispatch: jest.fn() } as never,
    );
    return service;
  }

  const track = (over: Record<string, unknown>) => ({
    id: 0,
    language: 'fr',
    forced: false,
    hearingImpaired: false,
    codec: 'hdmv_pgs_subtitle',
    streamIndex: 3,
    status: SubtitleStatus.DOWNLOADED,
    providerType: SubtitleProviderType.EMBEDDED,
    ...over,
  });

  const want = (over: Partial<SubtitleLanguageItem> = {}): SubtitleLanguageItem =>
    ({ isoCode: 'fr', name: 'French', forced: false, hi: false, ...over }) as SubtitleLanguageItem;

  const run = (subs: unknown[], item: SubtitleLanguageItem) =>
    (makeService() as never as { tryOcrFirst: (s: unknown[], i: unknown) => Promise<boolean> })
      .tryOcrFirst(subs, item);

  it('VERDICT: picks the full track, not the forced one, for a full request', async () => {
    // forced first, so a flag-blind `.find()` would take it
    const subs = [track({ id: 10, forced: true }), track({ id: 11, forced: false })];

    await expect(run(subs, want())).resolves.toBe(true);

    expect(ocrSubtitle).toHaveBeenCalledWith(11, 'fr', { automatic: true });
  });

  it('picks the forced track when the profile asks for forced', async () => {
    const subs = [track({ id: 11, forced: false }), track({ id: 10, forced: true })];

    await run(subs, want({ forced: true }));

    expect(ocrSubtitle).toHaveBeenCalledWith(10, 'fr', { automatic: true });
  });

  it('leaves the language to the providers when only a forced track exists', async () => {
    await expect(run([track({ id: 10, forced: true })], want())).resolves.toBe(false);
    expect(ocrSubtitle).not.toHaveBeenCalled();
  });

  it('an OCR run on the forced variant does not mark the full request handled', async () => {
    const subs = [
      track({ id: 10, forced: true, providerType: SubtitleProviderType.OCR, codec: 'subrip' }),
      track({ id: 11, forced: false }),
    ];

    await run(subs, want());

    expect(ocrSubtitle).toHaveBeenCalledWith(11, 'fr', { automatic: true });
  });

  it('VERDICT: a failed OCR run hands the language to the providers, no retry', async () => {
    const subs = [
      track({ id: 11, forced: false }),
      track({
        id: 12,
        providerType: SubtitleProviderType.OCR,
        codec: 'subrip',
        status: SubtitleStatus.FAILED,
      }),
    ];

    // the image track #11 is still there; without the FAILED row it would be
    // re-OCR'd on every scheduled sweep and the providers never reached
    await expect(run(subs, want())).resolves.toBe(false);
    expect(ocrSubtitle).not.toHaveBeenCalled();
  });

  it('a failed run on another language does not block this one', async () => {
    const subs = [
      track({ id: 11, forced: false }),
      track({
        id: 12,
        forced: true,
        providerType: SubtitleProviderType.OCR,
        codec: 'subrip',
        status: SubtitleStatus.FAILED,
      }),
    ];

    await run(subs, want());

    expect(ocrSubtitle).toHaveBeenCalledWith(11, 'fr', { automatic: true });
  });

  it('honours the HI mode: require takes the HI track, forbid rejects it', async () => {
    const subs = [track({ id: 11, hearingImpaired: false }), track({ id: 12, hearingImpaired: true })];

    await run(subs, want({ hi: true, hearingImpaired: 'require' }));
    expect(ocrSubtitle).toHaveBeenCalledWith(12, 'fr', { automatic: true });

    await expect(
      run([track({ id: 12, hearingImpaired: true })], want({ hearingImpaired: 'forbid' })),
    ).resolves.toBe(false);
  });
});
