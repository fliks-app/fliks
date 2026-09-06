import { NfoMetadataService } from './nfo-metadata.service';

describe('NfoMetadataService.parse', () => {
  const service = new NfoMetadataService();

  it('reads every field from a full Kodi movie NFO', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Quiet Harbour</title>
  <originaltitle>Quiet Harbour Original</originaltitle>
  <year>2009</year>
  <plot>A long plot about a harbour.</plot>
  <outline>Short outline.</outline>
  <genre>Drama</genre>
  <genre>Mystery</genre>
  <genre>Drama</genre>
  <runtime>118</runtime>
  <ratings>
    <rating name="imdb" default="true">
      <value>7.6</value>
      <votes>1200</votes>
    </rating>
    <rating name="tmdb">
      <value>7.2</value>
    </rating>
  </ratings>
  <premiered>2009-05-14</premiered>
  <uniqueid type="tmdb">1234</uniqueid>
  <uniqueid type="imdb">tt0001234</uniqueid>
</movie>`;

    const out = service.parse(xml);

    expect(out).toMatchObject({
      title: 'Quiet Harbour',
      originalTitle: 'Quiet Harbour Original',
      year: 2009,
      plot: 'A long plot about a harbour.',
      genres: ['Drama', 'Mystery'],
      runtime: 118,
      rating: 7.6,
      premiered: '2009-05-14',
      tmdbId: 1234,
      imdbId: 'tt0001234',
    });
  });

  it('falls back to <outline> when <plot> is absent', () => {
    const out = service.parse('<movie><outline>Only an outline.</outline></movie>');
    expect(out.plot).toBe('Only an outline.');
  });

  it('reads a tvshow.nfo with showtitle and an <id> tvdb id', () => {
    const xml = `<tvshow>
  <showtitle>Salt Meadow</showtitle>
  <year>2015</year>
  <genre>Comedy</genre>
  <id>556677</id>
</tvshow>`;

    const out = service.parse(xml);
    expect(out).toMatchObject({
      title: 'Salt Meadow',
      year: 2015,
      genres: ['Comedy'],
      tvdbId: 556677,
    });
  });

  it('falls back to any <ratings><rating><value> when no default is marked', () => {
    const xml = `<movie><ratings><rating name="tmdb"><value>5.5</value></rating></ratings></movie>`;
    expect(service.parse(xml).rating).toBe(5.5);
  });

  it('falls back to a flat <rating> tag when there is no <ratings> block', () => {
    const xml = '<movie><rating>8.1</rating></movie>';
    expect(service.parse(xml).rating).toBe(8.1);
  });

  it('drops a rating outside the 0-10 range', () => {
    const xml = '<movie><rating>42</rating></movie>';
    expect(service.parse(xml).rating).toBeUndefined();
  });

  it('derives the year from <premiered> when <year> is absent', () => {
    const xml = '<movie><premiered>2012-01-09</premiered></movie>';
    const out = service.parse(xml);
    expect(out.year).toBe(2012);
    expect(out.premiered).toBe('2012-01-09');
  });

  it('accepts a decimal comma in a rating value', () => {
    const xml = '<movie><rating>7,3</rating></movie>';
    expect(service.parse(xml).rating).toBe(7.3);
  });

  it('drops a <premiered> value that is not a real calendar date', () => {
    const xml = '<movie><premiered>2012-13-40</premiered></movie>';
    expect(service.parse(xml).premiered).toBeUndefined();
  });

  it('returns an empty object for malformed input instead of throwing', () => {
    expect(service.parse('not xml at all, just plain text')).toEqual({});
    expect(service.parse('<<<>>>garbage&&&')).toEqual({});
  });

  it('returns an empty object for a completely empty document', () => {
    expect(service.parse('')).toEqual({});
  });
});
