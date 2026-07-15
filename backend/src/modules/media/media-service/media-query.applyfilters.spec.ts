import { MediaQueryService } from './media-query.service';
import { SearchMediaDto } from '../dto/search-media.dto';

/**
 * Build a chainable query-builder stub that records every `andWhere` call so a
 * test can assert which clauses `applyFilters` emitted. Terminal methods are
 * present but unused here.
 */
function fakeQueryBuilder() {
  const andWhereCalls: [string, unknown?][] = [];
  const builder: any = {
    andWhereCalls,
    where: () => builder,
    andWhere: (clause: string, params?: unknown) => {
      andWhereCalls.push([clause, params]);
      return builder;
    },
    orderBy: () => builder,
    skip: () => builder,
    take: () => builder,
    getManyAndCount: () => Promise.resolve([[], 0]),
  };
  return builder;
}

function makeService(): MediaQueryService {
  return new MediaQueryService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

/** Collect the SQL fragments passed to `andWhere` for easy substring matching. */
function clauses(builder: { andWhereCalls: [string, unknown?][] }): string[] {
  return builder.andWhereCalls.map(([clause]) => clause);
}

describe('MediaQueryService.applyFilters', () => {
  let service: MediaQueryService;

  beforeEach(() => {
    service = makeService();
  });

  it('emits genres @>, year range, and rating clauses for a populated dto', () => {
    const qb = fakeQueryBuilder();
    const dto: SearchMediaDto = {
      genres: ['Action', 'Drama'],
      yearMin: 2000,
      yearMax: 2010,
      voteMin: 7,
    };

    (service as any).applyFilters(qb, dto);

    const emitted = clauses(qb);
    expect(emitted).toContain('media.genres @> :genres');
    expect(emitted).toContain('media.year >= :yearMin');
    expect(emitted).toContain('media.year <= :yearMax');
    expect(emitted).toContain('media.rating >= :voteMin');

    // Genres are matched by name via a JSON-encoded contains payload.
    const genresCall = qb.andWhereCalls.find(
      ([clause]: [string, unknown?]) => clause === 'media.genres @> :genres',
    );
    expect(genresCall?.[1]).toEqual({
      genres: JSON.stringify(['Action', 'Drama']),
    });
    const yearMinCall = qb.andWhereCalls.find(
      ([clause]: [string, unknown?]) => clause === 'media.year >= :yearMin',
    );
    expect(yearMinCall?.[1]).toEqual({ yearMin: 2000 });
    const yearMaxCall = qb.andWhereCalls.find(
      ([clause]: [string, unknown?]) => clause === 'media.year <= :yearMax',
    );
    expect(yearMaxCall?.[1]).toEqual({ yearMax: 2010 });
    const voteCall = qb.andWhereCalls.find(
      ([clause]: [string, unknown?]) => clause === 'media.rating >= :voteMin',
    );
    expect(voteCall?.[1]).toEqual({ voteMin: 7 });
  });

  it('emits none of the new clauses for an empty dto', () => {
    const qb = fakeQueryBuilder();

    (service as any).applyFilters(qb, {} as SearchMediaDto);

    const emitted = clauses(qb);
    expect(emitted).not.toContain('media.genres @> :genres');
    expect(emitted).not.toContain('media.year >= :yearMin');
    expect(emitted).not.toContain('media.year <= :yearMax');
    expect(emitted).not.toContain('media.rating >= :voteMin');
  });

  it('skips the genres clause when the array is empty', () => {
    const qb = fakeQueryBuilder();

    (service as any).applyFilters(qb, { genres: [] } as SearchMediaDto);

    expect(clauses(qb)).not.toContain('media.genres @> :genres');
  });

  it('keeps the single-genre and exact-year branches for other callers', () => {
    const qb = fakeQueryBuilder();

    (service as any).applyFilters(qb, {
      genre: 'Comedy',
      year: 1999,
    } as SearchMediaDto);

    const emitted = clauses(qb);
    expect(emitted).toContain('media.genres @> :genre');
    expect(emitted).toContain('media.year = :year');
    expect(emitted).not.toContain('media.genres @> :genres');
    expect(emitted).not.toContain('media.year >= :yearMin');
  });
});
