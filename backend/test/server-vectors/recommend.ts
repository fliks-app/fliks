import { RecommendationService } from '../../src/modules/playback/recommendation.service';
import { emit, maybe, mulberry32, pick, ri } from './_util';

type Media = { id: number; title: string; type: string; year: number; posterUrl: string | null; fanartUrl?: string | null; additionalFanartUrls?: string[]; genres: string[] | null; libraryId: number };
type Hist = { completed: boolean; lastPlayedAt: number; media: Partial<Media> | null };
type Input = {
  fn: 'getRecommendations' | 'getTopGenres';
  userId: number; libs: number[]; limit?: number; topLimit?: number;
  history: Hist[]; startedMediaIds: number[]; dismissedMediaIds: number[]; candidates: Media[]; availableRows: { mediaId: number | string }[];
};

// Stub repos replay what the SQL does: completed+order+take, id NOT IN, library IN, genres non-empty.
function service(i: Input) {
  const filters: { excluded: number[]; libs: number[] } = { excluded: [], libs: [] };
  const qb: any = {
    select: () => qb, where: () => qb, andWhere: (_: string, p: any) => { if (p?.excludedIds) filters.excluded = p.excludedIds; if (p?.libs) filters.libs = p.libs; return qb; },
    getMany: async () => i.candidates.filter((c) => c.genres?.length && !filters.excluded.includes(c.id) && filters.libs.includes(c.libraryId)),
  };
  const ids = (xs: number[]) => ({ select: () => ({ where: () => ({ getRawMany: async () => xs.map((mediaId) => ({ mediaId })) }) }) });
  const playbackRepo = {
    find: async (o: any) => i.history.filter((h) => h.completed === o.where.completed).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, o.take),
    createQueryBuilder: () => ids(i.startedMediaIds),
  };
  const dismissalRepo = { createQueryBuilder: () => ids(i.dismissedMediaIds) };
  const mediaRepo = {
    createQueryBuilder: () => qb,
    query: async (_: string, [top]: [number[]]) => i.availableRows.filter((r) => top.includes(Number(r.mediaId))),
  };
  return new RecommendationService(playbackRepo as never, mediaRepo as never, dismissalRepo as never);
}

const run = (i: Input): Promise<unknown> => {
  const s = service(i);
  return i.fn === 'getTopGenres' ? s.getTopGenres(i.userId, i.topLimit) : s.getRecommendations(i.userId, i.libs, i.limit);
};

const empty = (o: Partial<Input>): Input => ({ fn: 'getRecommendations', userId: 7, libs: [1], history: [], startedMediaIds: [], dismissedMediaIds: [], candidates: [], availableRows: [], ...o });
const m = (id: number, type: string, genres: string[] | null, libraryId = 1): Media => ({ id, title: `T${id}`, type, year: 2000 + (id % 25), posterUrl: `/p/${id}.jpg`, genres, libraryId });
const h = (id: number, genres: string[] | null, at: number, completed = true): Hist => ({ completed, lastPlayedAt: at, media: { id, title: `W${id}`, genres: genres as string[] } });

// no spec exists: hand-written scenarios
const handInputs: Input[] = [
  empty({ libs: [], history: [h(1, ['Action'], 9)], candidates: [m(10, 'movie', ['Action'])] }),
  empty({ candidates: [m(10, 'movie', ['Action'])] }),
  empty({ history: [h(1, [], 9), h(2, null, 8), { completed: true, lastPlayedAt: 7, media: null }], candidates: [m(10, 'movie', ['Action'])] }),
  empty({ history: [h(1, ['Action', 'Sci-Fi'], 9)], candidates: [m(10, 'movie', ['Action']), m(11, 'series', ['Action', 'Sci-Fi', 'Drama']), m(12, 'movie', ['Drama'])], availableRows: [{ mediaId: 10 }, { mediaId: '11' }] }),
  empty({ history: [h(1, ['Action'], 9, false)], candidates: [m(10, 'movie', ['Action'])] }),
  empty({ history: [h(1, ['Action'], 9), h(1, ['Action'], 5), h(2, ['Drama'], 4)], startedMediaIds: [20], dismissedMediaIds: [21], candidates: [m(20, 'movie', ['Action']), m(21, 'movie', ['Action']), m(22, 'movie', ['Drama']), m(1, 'movie', ['Action'])] }),
  empty({ history: [h(1, ['Action'], 9)], libs: [2], candidates: [m(10, 'movie', ['Action'], 1), m(11, 'movie', ['Action'], 2)] }),
  empty({ history: [h(1, ['Action'], 9)], candidates: Array.from({ length: 30 }, (_, k) => m(100 + k, 'movie', ['Action'])) }),
  empty({ history: [h(1, ['Action'], 9)], candidates: Array.from({ length: 30 }, (_, k) => m(100 + k, k < 20 ? 'movie' : 'series', ['Action', ...(k % 2 ? ['Drama'] : [])])) }),
  empty({ history: [h(1, ['Action'], 9)], limit: 50, candidates: Array.from({ length: 60 }, (_, k) => m(100 + k, k % 3 ? 'movie' : 'series', ['Action'])) }),
  { ...empty({ history: [h(1, ['Action'], 9), h(2, ['Drama', 'Action'], 8), h(3, ['Comedy'], 7)] }), fn: 'getTopGenres', topLimit: 2 },
];

// seeded synthetic histories + candidates
const rng = mulberry32(0x7ec0);
const R = (lo: number, hi: number) => ri(rng, lo, hi);
const GENRES = ['Action', 'Comedy', 'Drama', 'Sci-Fi', 'Horror', 'Romance', 'Animation', 'Thriller'];
const genres = (): string[] | null => {
  const k = rng();
  if (k < 0.07) return [];
  if (k < 0.1) return null;
  return [...new Set(Array.from({ length: R(1, 5) }, () => pick(rng, GENRES.slice(0, R(3, 8)))))];
};
const synth: Input[] = [];
for (let n = 0; n < 60; n++) {
  const pool = R(3, 14);
  const history: Hist[] = Array.from({ length: pick(rng, [1, 2, 6, 12, 18, 25]) }, (_, k) => {
    const id = R(1, pool);
    return { completed: rng() < 0.9, lastPlayedAt: 1_000_000 - k * 10 - (rng() < 0.3 ? 5 : 0), media: rng() < 0.05 ? null : { id, title: `W${id}`, genres: genres() as string[] } };
  });
  const candidates = Array.from({ length: pick(rng, [3, 4, 12, 25, 40]) }, (_, k) => ({
    ...m(100 + k, pick(rng, ['movie', 'movie', 'series', 'anime']), genres(), R(1, 4)),
    fanartUrl: maybe(rng, `/f/${k}.jpg`) ?? (rng() < 0.5 ? null : undefined), additionalFanartUrls: maybe(rng, ['/a.jpg']),
  }));
  const some = <T>(xs: T[], p: number) => xs.filter(() => rng() < p);
  synth.push(empty({
    fn: rng() < 0.1 ? 'getTopGenres' : 'getRecommendations', userId: R(1, 9), libs: pick(rng, [[1, 2, 3], [1, 2, 3, 4], [1, 2], [2, 4]]),
    limit: pick(rng, [undefined, 5, 15, 30, 50]), topLimit: pick(rng, [undefined, 3, 8]), history,
    startedMediaIds: [...some(candidates, 0.15).map((c) => c.id), ...some(Array.from({ length: pool }, (_, k) => k + 1), 0.2)],
    dismissedMediaIds: some(candidates, 0.1).map((c) => c.id), candidates,
    availableRows: some(candidates, 0.6).map((c) => ({ mediaId: rng() < 0.3 ? String(c.id) : c.id })),
  }));
}
// ties and one-type pools: same genre set everywhere, cap lifting
for (const n of [12, 24, 45]) {
  synth.push(empty({ libs: [1], limit: pick(rng, [undefined, 20]), history: [h(1, ['Action', 'Drama'], 9)], candidates: Array.from({ length: n }, (_, k) => m(100 + k, k % pick(rng, [2, 3]) ? 'movie' : 'series', ['Action', 'Drama'])) }));
}

const inputs = [...handInputs, ...synth];
emit('recommend', inputs, run).then(() => console.log(`recommend hand=${handInputs.length} generated=${synth.length}`));
