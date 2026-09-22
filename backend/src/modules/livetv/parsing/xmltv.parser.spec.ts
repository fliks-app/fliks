import { Readable } from 'stream';
import {
  parseXmltvStream,
  parseXmltvDate,
  decodeXmlText,
  XmltvProgramme,
  XmltvChannel,
} from './xmltv.parser';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="one.fr">
    <display-name>One</display-name>
    <display-name>One HD</display-name>
    <icon src="http://logo/one.png"/>
  </channel>
  <programme start="20260914183000 +0200" stop="20260914193000 +0200" channel="one.fr">
    <title>Le Match</title>
    <sub-title>Demi-finale</sub-title>
    <desc><![CDATA[Un résumé avec un < dedans]]></desc>
    <category>Sports</category>
    <category>Football</category>
    <episode-num system="xmltv_ns">0.2.0/1</episode-num>
    <episode-num system="dd_progid">EP123.0004</episode-num>
    <icon src="http://img/match.jpg"/>
    <star-rating><value>7/10</value></star-rating>
    <rating system="CSA"><value>-10</value></rating>
    <date>2026</date>
    <new/>
    <live/>
  </programme>
  <programme start="20260914193000 +0200" channel="one.fr">
    <title>Journal &amp; M&#233;t&#233;o</title>
    <episode-num system="onscreen">S03E07</episode-num>
  </programme>
</tv>`;

async function collect(
  chunks: string[],
): Promise<{ channels: XmltvChannel[]; programmes: XmltvProgramme[] }> {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];
  await parseXmltvStream(Readable.from(chunks), {
    onChannel: (c) => {
      channels.push(c);
    },
    onProgramme: (p) => {
      programmes.push(p);
    },
  });
  return { channels, programmes };
}

describe('parseXmltvStream', () => {
  it('reads channels and programmes with their metadata', async () => {
    const { channels, programmes } = await collect([FEED]);

    expect(channels).toEqual([
      {
        id: 'one.fr',
        displayNames: ['One', 'One HD'],
        iconUrl: 'http://logo/one.png',
      },
    ]);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]).toMatchObject({
      channelId: 'one.fr',
      title: 'Le Match',
      subtitle: 'Demi-finale',
      description: 'Un résumé avec un < dedans',
      categories: ['Sports', 'Football'],
      iconUrl: 'http://img/match.jpg',
      seasonNumber: 1,
      episodeNumber: 3,
      seriesId: 'dd_progid:EP123.0004',
      isNew: true,
      isLive: true,
      rating: '-10',
      year: 2026,
    });
    expect(programmes[0].startsAt.toISOString()).toBe('2026-09-14T16:30:00.000Z');
    expect(programmes[0].endsAt?.toISOString()).toBe('2026-09-14T17:30:00.000Z');
  });

  it('decodes entities and reads the onscreen episode dialect', async () => {
    const { programmes } = await collect([FEED]);
    expect(programmes[1].title).toBe('Journal & Météo');
    expect(programmes[1]).toMatchObject({ seasonNumber: 3, episodeNumber: 7 });
    expect(programmes[1].endsAt).toBeNull();
  });

  it('survives element boundaries falling anywhere in the stream', async () => {
    const byte = FEED.split('');
    const { channels, programmes } = await collect(byte);
    expect(channels).toHaveLength(1);
    expect(programmes.map((p) => p.title)).toEqual(['Le Match', 'Journal & Météo']);
  });

  it('skips a programme with no title or no start', async () => {
    const { programmes } = await collect([
      '<tv><programme channel="a"><title>No start</title></programme>' +
        '<programme start="20260101000000" channel="a"></programme></tv>',
    ]);
    expect(programmes).toEqual([]);
  });

  it('matches a <channel> tag whose attributes are not separated by a plain space', async () => {
    const { channels } = await collect([
      '<tv><channel\n  id="two.fr"><display-name>Two</display-name></channel></tv>',
    ]);
    expect(channels).toEqual([{ id: 'two.fr', displayNames: ['Two'], iconUrl: null }]);
  });
});

describe('title language preference', () => {
  const programmeFeed = (titles: string) =>
    `<tv><programme start="20260914183000 +0000" channel="a">${titles}</programme></tv>`;

  it('prefers the untagged title over an earlier tagged one when no language is configured', async () => {
    const { programmes } = await collect([
      programmeFeed('<title lang="fr">FR</title><title>Untagged</title>'),
    ]);
    expect(programmes[0].title).toBe('Untagged');
  });

  it('prefers the configured language over the untagged title', async () => {
    const programmes: XmltvProgramme[] = [];
    await parseXmltvStream(
      Readable.from([programmeFeed('<title>Untagged</title><title lang="en">EN</title>')]),
      { onProgramme: (p) => { programmes.push(p); } },
      { language: 'en' },
    );
    expect(programmes[0].title).toBe('EN');
  });

  it('falls back to the first title when nothing untagged or preferred is present', async () => {
    const { programmes } = await collect([
      programmeFeed('<title lang="fr">FR</title><title lang="de">DE</title>'),
    ]);
    expect(programmes[0].title).toBe('FR');
  });
});

describe('parseXmltvDate', () => {
  it('honours the embedded offset', () => {
    expect(parseXmltvDate('20260914183000 +0200')?.toISOString()).toBe(
      '2026-09-14T16:30:00.000Z',
    );
  });

  it('applies the feed offset when the stamp carries none', () => {
    expect(parseXmltvDate('20260914183000', 120)?.toISOString()).toBe(
      '2026-09-14T16:30:00.000Z',
    );
  });

  it('accepts a stamp with no seconds and rejects junk', () => {
    expect(parseXmltvDate('202609141830')?.toISOString()).toBe(
      '2026-09-14T18:30:00.000Z',
    );
    expect(parseXmltvDate('soon')).toBeNull();
    expect(parseXmltvDate(undefined)).toBeNull();
  });
});

describe('decodeXmlText', () => {
  it('unwraps CDATA and numeric entities', () => {
    expect(decodeXmlText('<![CDATA[a & b]]>')).toBe('a & b');
    expect(decodeXmlText('&#x41;&#66;&amp;')).toBe('AB&');
  });

  it('leaves an out-of-range numeric entity untouched instead of throwing', () => {
    expect(() => decodeXmlText('&#xFFFFFF;')).not.toThrow();
    expect(decodeXmlText('&#xFFFFFF;')).toBe('&#xFFFFFF;');
    expect(decodeXmlText('&#99999999;')).toBe('&#99999999;');
    // A valid entity elsewhere in the same string still decodes.
    expect(decodeXmlText('ok &#65; &#xFFFFFF; end')).toBe('ok A &#xFFFFFF; end');
  });
});
