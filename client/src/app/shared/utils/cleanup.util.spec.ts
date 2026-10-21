import { cleanCriteria, daysLeft } from './cleanup.util';

describe('cleanup.util', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');

  it('rounds the days left up and floors at zero', () => {
    expect(daysLeft('2026-01-10T12:00:00Z', now)).toBe(0);
    expect(daysLeft('2026-01-10T13:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-01-17T12:00:00Z', now)).toBe(7);
    expect(daysLeft('2026-01-01T00:00:00Z', now)).toBe(0);
  });

  it('keeps zero and drops empty values', () => {
    expect(
      cleanCriteria({ addedOlderThanDays: 0, neverPlayed: false, genres: [], libraryIds: [1], sizeAboveGb: NaN }),
    ).toEqual({ addedOlderThanDays: 0, libraryIds: [1] });
  });

  it('drops minVotes without ratingBelow', () => {
    expect(cleanCriteria({ minVotes: 10 })).toEqual({});
    expect(cleanCriteria({ minVotes: 10, ratingBelow: 5 })).toEqual({ minVotes: 10, ratingBelow: 5 });
  });
});
