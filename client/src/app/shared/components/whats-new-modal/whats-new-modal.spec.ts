import { parseWhatsNew, versionsToShow } from './whats-new-modal';

describe('parseWhatsNew', () => {
  const base = 'https://fliks.test/whats-new/7.0.0/';

  it('makes one slide per section, lifting the first image out of the body', () => {
    const md = [
      'Intro text before any section is ignored.',
      '## Karaoke',
      '![Lyrics on screen](karaoke.webp)',
      'Sing along with **any** track.',
      '',
      '## Music',
      'A new album page.',
    ].join('\n');

    expect(parseWhatsNew(md, base)).toEqual([
      {
        title: 'Karaoke',
        image: 'https://fliks.test/whats-new/7.0.0/karaoke.webp',
        alt: 'Lyrics on screen',
        body: 'Sing along with **any** track.',
      },
      { title: 'Music', image: null, alt: '', body: 'A new album page.' },
    ]);
  });

  it('returns nothing for a file without sections', () => {
    expect(parseWhatsNew('Just a line.', base)).toEqual([]);
  });
});

describe('versionsToShow', () => {
  const index = ['5.2.0', '6.0.0', '7.0.0', '7.1.0', '8.0.0'];

  it('shows every version after the last seen one up to the current, oldest first', () => {
    expect(versionsToShow(index, '5.4.1', '7.0.3')).toEqual(['6.0.0', '7.0.0']);
  });

  it('caps a long jump at the latest three versions', () => {
    expect(versionsToShow(index, '5.0.0', '8.0.0')).toEqual(['7.0.0', '7.1.0', '8.0.0']);
  });

  it('compares numerically and ignores a pre-release suffix', () => {
    expect(versionsToShow(['6.10.0', '6.9.0'], '6.9.0', '6.10.0-beta.2')).toEqual(['6.10.0']);
  });
});
