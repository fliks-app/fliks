import { PlaybackService } from './playback.service';
import { PlaybackState } from './entities/playback-state.entity';

/**
 * `updateState` only needs `findState` + `repo`, so we exercise it on a bare
 * prototype instance rather than the full multi-dependency constructor. The
 * contract under test: a media enters the watch history (`playedAt`) only once
 * at least 5 s of progress is reported.
 */
function buildService(existing: Partial<PlaybackState> | null) {
  const service = Object.create(PlaybackService.prototype) as PlaybackService;
  const save = jest.fn(async (x: unknown) => x);
  const wired = service as unknown as { repo: unknown; findState: unknown };
  wired.repo = { save, create: (x: unknown) => ({ ...(x as object) }) };
  wired.findState = jest.fn(async () => existing);
  return { service, save };
}

const body = (positionSeconds: number) => ({
  positionSeconds,
  durationSeconds: 1000,
  mediaFileId: 9,
});

describe('PlaybackService.updateState — history 5s threshold', () => {
  it('does not stamp playedAt below 5s on a fresh row', async () => {
    const { service, save } = buildService(null);
    await service.updateState(1, 2, body(3));
    expect(save.mock.calls[0][0]).toMatchObject({ playedAt: null });
  });

  it('stamps playedAt at or above 5s on a fresh row', async () => {
    const { service, save } = buildService(null);
    await service.updateState(1, 2, body(7));
    expect((save.mock.calls[0][0] as PlaybackState).playedAt).toBeInstanceOf(
      Date,
    );
  });

  it('refreshes playedAt for a watched existing row', async () => {
    const existing = { positionSeconds: 0, playedAt: null } as Partial<PlaybackState>;
    const { service } = buildService(existing);
    await service.updateState(1, 2, body(50));
    expect(existing.playedAt).toBeInstanceOf(Date);
  });

  it('keeps a prior history stamp when a brief re-touch is below 5s', async () => {
    const prior = new Date(Date.now() - 100_000);
    const existing = { positionSeconds: 0, playedAt: prior } as Partial<PlaybackState>;
    const { service } = buildService(existing);
    await service.updateState(1, 2, body(3));
    // Below threshold must not pull the item back out of (or re-stamp) history.
    expect(existing.playedAt).toBe(prior);
  });
});
