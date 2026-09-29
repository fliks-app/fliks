import { extractMediaTitle } from './title.extractor';

describe('extractMediaTitle', () => {
  it('leaves the video extension out of a file name with no other anchor', () => {
    expect(extractMediaTitle('sample.mkv').title).toBe('sample');
  });

  it('keeps a dotted title intact when only the extension is stripped', () => {
    expect(extractMediaTitle('Lonely.Harbor.2021.1080p.mkv')).toMatchObject({
      title: 'Lonely Harbor',
      year: 2021,
    });
  });
});
