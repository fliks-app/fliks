import { scoreSimilarity } from './media-related.service';
import { Media } from '../entities/media.entity';

type Candidate = Pick<Media, 'genres' | 'year' | 'metadata'>;

const movie = (
  genres: string[],
  year: number,
  keywords: string[] = [],
): Candidate =>
  ({ genres, year, metadata: { keywords } }) as unknown as Candidate;

const source = movie(['Action', 'Thriller'], 2010, ['heist', 'dream']);

describe('similarity scoring', () => {
  it('ranks two shared keywords above an identical genre pair', () => {
    const keywordMatch = movie(['Drama'], 2010, ['heist', 'dream']);
    const genreMatch = movie(['Action', 'Thriller'], 2010);
    expect(scoreSimilarity(source, keywordMatch, false)).toBeGreaterThan(
      scoreSimilarity(source, genreMatch, false),
    );
  });

  it('keeps a single keyword below an identical genre pair', () => {
    expect(scoreSimilarity(source, movie(['Drama'], 2010, ['heist']), false)).toBeLessThan(
      scoreSimilarity(source, movie(['Action', 'Thriller'], 2010), false),
    );
  });

  it('normalizes genre overlap by the candidate breadth', () => {
    const tight = movie(['Action', 'Thriller'], 2010);
    const catchAll = movie(
      ['Action', 'Thriller', 'Drama', 'Comedy', 'Horror', 'Western'],
      2010,
    );
    expect(scoreSimilarity(source, tight, false)).toBeGreaterThan(
      scoreSimilarity(source, catchAll, false),
    );
  });

  it('caps the keyword contribution so a tag dump cannot dominate', () => {
    const many = movie([], 2010, ['heist', 'dream', 'a', 'b', 'c', 'd']);
    const two = movie([], 2010, ['heist', 'dream']);
    expect(scoreSimilarity(source, many, false)).toBeCloseTo(
      scoreSimilarity(source, two, false),
    );
  });

  it('scores nothing for a title sharing no signal', () => {
    expect(scoreSimilarity(source, movie(['Documentary'], 1950), false)).toBe(0);
  });

  it('rewards the same director and closer release years', () => {
    const other = movie(['Drama'], 2010);
    expect(scoreSimilarity(source, other, true)).toBeGreaterThan(
      scoreSimilarity(source, other, false),
    );
    expect(scoreSimilarity(source, movie(['Action'], 2011), false)).toBeGreaterThan(
      scoreSimilarity(source, movie(['Action'], 1985), false),
    );
  });
});
