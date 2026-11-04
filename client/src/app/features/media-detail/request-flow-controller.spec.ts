import { describe, it, expect, vi } from 'vitest';
import type { Media } from '../../core/services/api/media.service';
import { RequestFlowController, mediaTitleKey } from './request-flow-controller';

const media = (m: Partial<Media>): Media => ({ id: 1, type: 'series', title: 'T', ...m }) as Media;

describe('mediaTitleKey', () => {
  it('keys by TMDB id, else a plugin id, else the TVDB id', () => {
    expect(mediaTitleKey(media({ tmdbId: 5, tvdbId: 7 }))).toEqual({ tmdbId: 5 });
    expect(
      mediaTitleKey(media({ tmdbId: null, externalIds: [{ provider: 'org.x:aid', value: '9' }] })),
    ).toEqual({ provider: 'org.x:aid', externalId: '9' });
    expect(mediaTitleKey(media({ tmdbId: null, tvdbId: 7 }))).toEqual({
      provider: 'tvdb',
      externalId: '7',
    });
    expect(mediaTitleKey(media({ tmdbId: null }))).toBeNull();
  });
});

describe('RequestFlowController on a plugin-only title', () => {
  const m = media({ tmdbId: null, externalIds: [{ provider: 'org.x:aid', value: '9' }] });
  function setup() {
    const requests = {
      getTitleState: vi.fn().mockResolvedValue({ requested: false }),
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({}),
    };
    const deps = {
      auth: { hasPermission: (p: string) => p === 'requests.create' },
      requests,
      confirmation: { confirm: vi.fn().mockResolvedValue(true) },
      toast: { success: vi.fn() },
      translate: { instant: (k: string) => k },
    };
    const open = vi.fn();
    const c = new RequestFlowController(
      { media: () => m, requestModal: () => ({ open }) as never },
      deps as never,
    );
    return { c, requests, open };
  }

  it('offers the actions and reads the state by provider and id', async () => {
    const { c, requests } = setup();
    expect(c.canRequest()).toBe(true);
    expect(c.canRequestDeletion()).toBe(true);
    c.load(m);
    await Promise.resolve();
    expect(requests.getTitleState).toHaveBeenCalledWith(
      { provider: 'org.x:aid', externalId: '9' },
      'series',
    );
  });

  it('opens the request modal and asks for the deletion with that key', async () => {
    const { c, requests, open } = setup();
    c.openForMedia();
    expect(open.mock.calls[0][0].titleKey).toEqual({ provider: 'org.x:aid', externalId: '9' });
    await c.requestDeletion();
    expect(requests.create).toHaveBeenCalledWith({
      kind: 'delete',
      mediaType: 'series',
      provider: 'org.x:aid',
      externalId: '9',
      title: 'T',
    });
  });
});
