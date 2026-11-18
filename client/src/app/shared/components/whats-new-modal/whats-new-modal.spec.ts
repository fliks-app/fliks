import { parseWhatsNew } from './whats-new-modal';

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
