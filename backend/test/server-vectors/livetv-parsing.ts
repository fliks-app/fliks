import { Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { parseM3u, deriveExternalId, isOnDemandUrl } from '../../src/modules/livetv/parsing/m3u.parser';
import { normalizeChannelName, nameSimilarity } from '../../src/modules/livetv/parsing/channel-name';
import { normalizeGroupName } from '../../src/modules/livetv/parsing/group-name';
import { foldGroupKey } from '../../src/modules/livetv/parsing/group-key';
import {
  decodeXmlText,
  parseXmltvDate,
  parseXmltvStream,
  type XmltvChannel,
  type XmltvProgramme,
} from '../../src/modules/livetv/parsing/xmltv.parser';
import { matchGuideChannels, pickHighestPriorityRows } from '../../src/modules/livetv/parsing/guide-match';
import {
  detectXtreamFromStreamUrl,
  detectXtreamFromUrl,
  pickOutputFormat,
  xtreamPlaylistUrl,
  XtreamClient,
} from '../../src/modules/livetv/services/xtream.client';
import {
  classifyEntries,
  compileGroupPattern,
  liveTvAccountStateOf,
} from '../../src/modules/livetv/services/livetv-sources.service';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);

// ---- inputs -------------------------------------------------------------------------------

const m3u = (text: string) => ({ fn: 'parseM3u', text });
const lines = (...l: string[]) => l.join('\n');

const m3uInputs: unknown[] = [
  m3u(lines(
    '#EXTM3U x-tvg-url="http://provider/xmltv.php?u=a"',
    '#EXTINF:-1 tvg-id="C1.fr" tvg-name="One" tvg-logo="http://logo/1.png" tvg-chno="7" group-title="News",One FHD',
    'http://provider/live/u/p/101.ts',
  )),
  m3u('#EXTM3U x-tvg-url="http://a/xmltv.php,http://b/epg.xml"\n'),
  m3u('#EXTM3U url-tvg=" http://a/x , ,http://b/y "\n'),
  m3u('#EXTM3U x-tvg-url="" url-tvg="http://fallback/x"\n'),
  m3u(lines('#EXTINF:-1,Two', '#EXTGRP:Sport', 'http://provider/2.ts')),
  m3u(lines('#EXTINF:-1,Two', '#EXTGRP', 'http://provider/2.ts')),
  m3u(lines('#EXTGRP:Early', '#EXTINF:-1,Two', 'http://provider/2.ts')),
  m3u(lines('#EXTINF:-1 group-title="XXX  ",One', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1,One', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1 group-title="Own",One', '#EXTGRP:Other', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1 tvg-shift="-0.5",Three', 'http://provider/3.ts')),
  m3u(lines('#EXTINF:-1 tvg-shift="1.25",Three', 'http://provider/3.ts', '#EXTINF:-1 tvg-shift="x",Four', 'http://provider/4.ts', '#EXTINF:-1 tvg-shift="2.5",Five', 'http://provider/5.ts')),
  m3u(lines('#EXTINF:-1,Four', '#EXTVLCOPT:some-other-option=1', 'http://provider/4.ts', '#EXTINF:-1,Dangling')),
  m3u(lines('#EXTINF:-1 tvg-id="one.fr",One HD', 'http://provider/live/u/p/101.ts', '#EXTINF:-1 tvg-id="one.fr",One FHD', 'http://provider/live/u/p/102.ts')),
  m3u(lines('#EXTINF:-1,A', 'http://provider/live/u/p/101.ts', '#EXTINF:-1,A again', 'http://provider/live/u/p/101.ts')),
  m3u(lines('#EXTINF:-1,A', '#EXTVLCOPT:http-user-agent=VLC/3.0.20 LibVLC/3.0.20', '#EXTVLCOPT:http-referrer=http://portal.example/', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1,A', '#EXTVLCOPT:http-referer=http://portal.example/single', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1,A', '#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Kodi%2F20&Referer=http%3A%2F%2Fp.example%2F', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1,A', '#KODIPROP:inputstream.adaptive.stream_headers=Referer=http://p.example/', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1,A', '#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=%E0%A4%A&Referer=%zz', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1,A', '#EXTVLCOPT:http-user-agent=Custom/1.0', 'http://provider/1.ts', '#EXTINF:-1,B', 'http://provider/2.ts')),
  m3u(lines('#EXTVLCOPT:http-user-agent=Orphan', '#EXTINF:-1,A', 'http://provider/1.ts')),
  m3u('﻿#EXTM3U\n#EXTINF:-1,A\nhttp://provider/1.ts\n'),
  m3u('#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://provider/1.ts\r\n#EXTINF:-1,B\r\nhttp://provider/2.ts\r\n'),
  m3u(lines('#EXTINF:-1 tvg-chno="" channel-number="9",A', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1 channel-number="9",A', 'http://provider/1.ts', '#EXTINF:-1 tvg-chno="12abc",B', 'http://provider/2.ts', '#EXTINF:-1 tvg-chno="-3",C', 'http://provider/3.ts')),
  m3u(lines('#EXTINF:-1 tvg-name="Fallback",', 'http://provider/1.ts', '#EXTINF:-1 tvg-name="",', 'http://provider/2.ts')),
  m3u(lines('#EXTINF:-1 tvg-name="a, b" tvg-id="x",Real, Name', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1 tvg-name="a, b",', 'http://provider/1.ts')),
  m3u(lines('#EXTINF:-1 tvg-quality="FHD" Tvg-Logo="http://l/x.png" tvg-id="a" tvg-id="b",A', 'http://provider/1.ts')),
  m3u(lines('#EXTM3U max-conn="2"', '#EXTM3U x-tvg-url="http://last/x"', '#EXTINF:-1,A', 'http://provider/1.ts')),
  m3u('#EXTM3U max-conn="0" billed-till="1893456000"\n'),
  m3u('#EXTM3U max-conn="" billed-till="30"\n'),
  m3u('#EXTM3U max-conn="3x" billed-till="2029-12-31"\n'),
  m3u('#EXTM3U billed-till="2029-12-31T10:20:30Z"\n'),
  m3u('#EXTM3U billed-till="2029-12-31T10:20:30.5+02:00"\n'),
  m3u('#EXTM3U billed-till="not-a-date"\n'),
  m3u(lines('#EXTINF:-1,Index', 'http://a/live/index.m3u8', '#EXTINF:-1,Master', 'http://b/hls/master.m3u8', '#EXTINF:-1,Plain', 'http://c/9')),
  m3u(lines('#EXTINF:-1,No ext', 'http://h:8080/live/u/p/4321', '#EXTINF:-1,Query', 'http://h/live/u/p/77.m3u8?x=1&y=2', '#EXTINF:-1,Odd', 'http://h/a b/c')),
  m3u(lines('#EXTINF:-1,Slash', 'http://h/', '#EXTINF:-1,Empty path', 'rtmp://h')),
  m3u(lines('#EXTINF:-1,Weird', '#EXTM3UX', 'http://h/1.ts', '# comment', '#EXTINF:-1,Next', 'http://h/2.ts', 'stray line')),
  m3u(lines('  #EXTINF:-1,  Padded  ', '  http://h/1.ts  ', '', '   ')),
  m3u(''),
  m3u('no playlist at all'),
];

// A seeded corpus of generated playlists.
{
  const rng = mulberry32(20261016);
  const NAMES = ['One', 'Canal+ Décalé FHD', 'FR: Sport 1 HD', 'uk | News 24', '[HD] Movies', 'Kids (Backup)', 'Zürich TV', '日本 TV', 'A', 'B & C', ' padded ', ''];
  const GROUPS = ['News', ' XXX ', '', 'Sport  FR', 'Adult', ' Nbsp ', '﻿Bom', '\u0085Nel'];
  const URLS = ['http://h/live/u/p/%d.ts', 'http://h/%d/index.m3u8', 'http://h/movie/u/p/%d.mp4', 'http://h/series/u/p/%d.mkv', 'http://h/stream?id=%d', 'http://h/%d'];
  const DIRECTIVES = ['#EXTVLCOPT:http-user-agent=UA/%d', '#EXTVLCOPT:http-referrer=http://r/%d', '#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=K%%2F%d', '#EXTGRP:G%d', '#UNKNOWN:%d'];
  for (let n = 0; n < 40; n++) {
    const out: string[] = [];
    if (rng() < 0.7) out.push(`#EXTM3U${rng() < 0.5 ? ' x-tvg-url="http://g/x.xml"' : ''}${rng() < 0.3 ? ` max-conn="${ri(rng, 0, 5)}"` : ''}`);
    for (let e = 0; e < ri(rng, 1, 8); e++) {
      const attrs: string[] = [];
      if (rng() < 0.6) attrs.push(`tvg-id="id${ri(rng, 1, 4)}"`);
      if (rng() < 0.6) attrs.push(`group-title="${pick(rng, GROUPS)}"`);
      if (rng() < 0.3) attrs.push(`tvg-chno="${pick(rng, ['', '7', 'x', '12.5'])}"`);
      if (rng() < 0.2) attrs.push(`tvg-shift="${pick(rng, ['-1', '0.5', '', 'x'])}"`);
      if (rng() < 0.2) attrs.push(`tvg-logo="http://l/${ri(rng, 1, 9)}.png"`);
      out.push(`#EXTINF:-1 ${attrs.join(' ')},${pick(rng, NAMES)}`);
      for (let d = 0; d < ri(rng, 0, 2); d++) out.push(pick(rng, DIRECTIVES).replace('%d', String(ri(rng, 1, 9))));
      if (rng() < 0.9) out.push(pick(rng, URLS).replace('%d', String(ri(rng, 1, 30))));
    }
    m3uInputs.push(m3u(out.join(rng() < 0.3 ? '\r\n' : '\n')));
  }
}

const ID_CASES: [string, string][] = [
  ['http://h/9.ts', 'X'], ['http://h:8080/live/u/p/4321.m3u8?x=1', 'X'], ['http://h/', 'Canal + HD'],
  ['http://a/live/index.m3u8', 'One'], ['http://b/hls/master.m3u8', 'Two'], ['', 'FR: Canal+ Décalé'],
  ['http://h/live/Stream.ts', 'S'], ['http://h/a.b.c', 'S'], ['http://h/ü.ts', 'S'], ['http://h/%20.ts', 'S'],
];
const OD_CASES = ['http://h/movie/u/p/1.mp4', 'http://h/series/u/p/1/2/3.mp4', 'http://h/MOVIE/u/p/1.mp4', 'http://h/live/u/p/1.ts', 'http://h/u/p/1.ts', 'http://h/movies-catalog/1.ts', 'http://h/live/1.ts?x=/movie/', ''];
const GROUP_CASES: (string | null)[] = ['XXX ', '  News', ' News  FR ', '', '   ', null, '﻿', ' x ', '\u0085', ' a ', '\t\n a \r', 'a​b', '​'];

const names: unknown[] = [];
{
  const rng = mulberry32(7);
  const parts = ['FR:', 'uk |', 'DE|', 'ES :', '[HD]', '(1080p)', '[Backup]', 'Canal+', 'Décalé', 'Sport', 'One', 'HD', 'FHD', '4K', 'plus+', 'Plus', 'raw', 'multi', 'VIP', 'h265', '720', 'ñandú', 'Zürich', '日本', '東京', 'a', 'x1', '', '  ', '+', 'ÉCOLE', 'Œuvre', 'İstanbul', 'ΣΑΣ'];
  const fixed = ['FR: Canal+ Décalé FHD', 'canal+ decale', 'One [Backup] (1080p)', 'Canal+', 'Canal', '[HD] FR: x', 'Sport plus+', 'Sport Plus', 'hd', '', '   ', 'FR:', 'FRA: x', 'FRAN: x', 'a: b', 'one (a (b) c)', 'one [a [b] c]', 'HD HD HD', '1080p 1080 720p 720 576 480p', 'plus', 'plus+', 'plus++', '4k8k'];
  for (const f of fixed) names.push({ fn: 'normalizeChannelName', raw: f });
  for (let i = 0; i < 150; i++) names.push({ fn: 'normalizeChannelName', raw: Array.from({ length: ri(rng, 1, 5) }, () => pick(rng, parts)).join(rng() < 0.7 ? ' ' : '') });
  for (let i = 0; i < 60; i++) {
    const a = Array.from({ length: ri(rng, 0, 4) }, () => pick(rng, parts)).join(' ');
    const b = Array.from({ length: ri(rng, 0, 4) }, () => pick(rng, parts)).join(' ');
    names.push({ fn: 'nameSimilarity', a, b });
  }
  names.push({ fn: 'nameSimilarity', a: 'Sport One HD', b: 'Sport One' }, { fn: 'nameSimilarity', a: 'Sport One', b: 'Movies Two' }, { fn: 'nameSimilarity', a: '', b: 'One' }, { fn: 'nameSimilarity', a: 'a b a', b: 'a b' });
}

const entry = (url: string, groupName: string) => ({ externalId: url, name: url, url, logo: null, groupName, tvgId: null, number: null, qualityLabel: null, shiftMinutes: 0, userAgent: null, referer: null });
const classify = (groups: string[], include: string | null, exclude: string | null, urls?: string[]) => ({
  fn: 'classifyEntries',
  entries: groups.map((g, i) => entry(urls?.[i] ?? `http://h/live/${i}.ts`, g)),
  include,
  exclude,
});
const classifyInputs: unknown[] = [
  classify(['News', 'Sport', 'Sport', 'XXX', 'News', 'Sport'], null, null),
  classify(['News', 'Sport', 'Sport', 'XXX'], 'sport|news', 'xxx'),
  classify(['News', 'Sport'], 'news', 'news'),
  classify(['News', 'Films', 'Sport'], null, null, ['http://h/live/1.ts', 'http://h/movie/2.mp4', 'http://h/series/3.mkv']),
  classify(['A', 'B', 'A', 'C', 'B', 'C', 'C'], null, null),
  classify(['Z', 'Y', 'X'], null, null),
  classify(['__livetv_ungrouped__', 'Sport'], '^__livetv', null),
  classify(['News FR', 'News EN', 'Sport'], '^(?!.*en).*news', null),
  classify(['abc abc', 'abc def', 'a1', 'a١'], '(\\w+) \\1', null),
  classify(['123', '١٢٣'], '^\\d+$', null),
  classify(['ÉCOLE', 'école'], '^école$', null),
  classify(['Kids', 'kids'], 'KIDS', null),
  classify(['a b', 'a b'], 'a\\sb', null),
];

const states: unknown[] = [];
{
  const now = '2026-10-16T12:00:00.000Z';
  const day = 86_400_000;
  const base = Date.parse(now);
  for (const [off, status] of [[-1, null], [0, null], [1, null], [7 * day, null], [7 * day + 1, null], [30 * day, null], [null, null], [null, 'Active'], [30 * day, 'Expired'], [30 * day, 'EXPIRED'], [30 * day, 'expired '], [-day, 'Active'], [null, 'Banned']] as [number | null, string | null][]) {
    states.push({ fn: 'liveTvAccountStateOf', expiresAt: off === null ? null : new Date(base + off).toISOString(), status, now });
  }
}

const xtream: unknown[] = [
  ...[
    'http://host:8080/get.php?username=u&password=p&type=m3u',
    'http://host/player_api.php?username=u&password=p',
    'https://host:443/xmltv.php?username=u%20x&password=p%2Bq',
    'http://host/prefix/get.php?username=u&password=p',
    'http://HOST:80/GET.PHP?username=u&password=p',
    'http://host/get.php?username=u',
    'http://host/get.php?username=&password=p',
    'http://host/live/u/p/1.ts',
    'http://user:pw@host/get.php?username=u&password=p',
    'http://[::1]:8080/get.php?username=u&password=p',
    'ftp://host/get.php?username=u&password=p',
    'not a url',
    '',
    'http://host/get.php?username=a&username=b&password=p',
    'http://host/get.php?username=a+b&password=c%26d',
    '/local/file.m3u',
  ].map((raw) => ({ fn: 'detectXtreamFromUrl', raw })),
  ...[
    'http://panel.example:8080/live/joe/s3cret/1234.ts',
    'https://p.example/joe/s3cret/9.m3u8',
    'https://cdn.example/hls/live/2031003/x/index.m3u8',
    'http://h/',
    'not a url',
    'http://h/movie/a/b/1.mp4',
    'http://h/series/a/b/1.mp4',
    'http://h/LIVE/a/b/1.ts',
    'http://h/live/a/b/1',
    'http://h/live/a/b/.ts',
    'http://h/live/a%20b/p%2Fw/1.ts',
    'http://h/a/b/c/d/1.ts',
    'http://h//live//a//b//1.ts',
    'http://h/live/a/b',
  ].map((raw) => ({ fn: 'detectXtreamFromStreamUrl', raw })),
  ...[
    { baseUrl: 'http://panel.example:8080', username: 'jo e', password: 'p/w' },
    { baseUrl: 'http://h', username: "u~!'()*", password: 'p @&=+$,;:?#[]' },
    { baseUrl: 'http://h', username: 'é', password: '日本' },
  ].map((creds) => ({ fn: 'xtreamPlaylistUrl', creds })),
  ...[[['m3u8', 'ts']], [['m3u8']], [[]], [['hls', 'rtmp']], [['ts']], [['TS']]].map(([allowed]) => ({ fn: 'pickOutputFormat', allowed })),
  ...[
    { user_info: { auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '3', active_cons: '1', allowed_output_formats: ['M3U8', 'TS'] } },
    { user_info: { auth: 1 } },
    { user_info: { auth: 0 } },
    { user_info: { auth: '0' } },
    { user_info: {} },
    { user_info: { exp_date: 0, max_connections: 'x' } },
    { user_info: { exp_date: 1893456000.9, max_connections: 2.5, status: '  ok ' } },
    { user_info: { allowed_output_formats: 'ts', status: '' } },
    {},
    'html login page',
    null,
    { user_info: null },
    { user_info: false },
  ].map((data) => ({ fn: 'xtreamAccount', data })),
];

const panel = (categories: unknown, streams: unknown) => ({ fn: 'xtreamLiveStreams', categories, streams });
xtream.push(
  panel([{ category_id: '1', category_name: 'News' }], [{ stream_id: 1, name: 'One', category_id: '1', direct_source: 'http://cdn/one.m3u8' }, { stream_id: 2, name: 'Two', category_id: '1' }]),
  panel([{ category_id: '1', category_name: '  XXX  ' }, { category_id: '2', category_name: '' }], [{ stream_id: 1, name: 'One', category_id: '1' }, { stream_id: 2, name: 'Two', category_id: '2' }, { stream_id: 3, name: 'Three' }]),
  panel([{ category_id: 1, category_name: 'Num' }], [{ stream_id: 7, name: ' Padded ', category_id: 1, num: '12', stream_icon: ' http://i/1.png ', epg_channel_id: ' e1 ' }, { stream_id: '8', name: 'Str', category_id: '1', num: 0, stream_icon: '', epg_channel_id: null }, { stream_id: null, name: 'NoId' }, { name: 'NoId2' }, { stream_id: 9, name: '   ' }, { stream_id: 10, name: 123, category_id: null, num: 'x' }]),
  panel(null, null),
  panel([], [{ stream_id: 1.5, name: 'Float' }, { stream_id: true, name: 'Bool' }, { stream_id: 'a b', name: 'Space', direct_source: 'x' }]),
  panel([{ category_id: '1', category_name: 'A' }, { category_id: '1', category_name: 'B' }], [{ stream_id: 1, name: 'Dup cat', category_id: '1' }]),
  panel([{ category_name: 'NoId' }], [{ stream_id: 1, name: 'x' }]),
);

// ---- guide --------------------------------------------------------------------------------

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

const xml = (xmlText: string, extra: Record<string, unknown> = {}) => ({ fn: 'parseXmltvStream', xml: xmlText, ...extra });
const prog = (inner: string, attrs = 'start="20260914183000 +0000" channel="a"') => `<programme ${attrs}>${inner}</programme>`;
const xmltv: unknown[] = [
  xml(FEED),
  xml(FEED, { language: 'fr', offsetMinutes: 60 }),
  xml('<tv><channel\n  id="two.fr"><display-name>Two</display-name></channel></tv>'),
  xml('<tv><channel id="a"/><channel id=""><display-name>x</display-name></channel><channel><display-name>noid</display-name></channel></tv>'),
  xml('<tv><channel id="a"><icon src=""/><icon src="http://second"/></channel><channel id="b"><icon/><icon src="http://x"/></channel></tv>'),
  xml('<tv><channel id="a"><display-name> </display-name><display-name>x &amp; y</display-name><display-name><![CDATA[c &amp; d]]></display-name></channel></tv>'),
  xml('<tv><programme channel="a"><title>No start</title></programme><programme start="20260101000000" channel="a"></programme><programme start="20260101000000"><title>No channel</title></programme></tv>'),
  xml(`<tv>${prog('<title lang="fr">FR</title><title>Untagged</title>')}</tv>`),
  xml(`<tv>${prog('<title>Untagged</title><title lang="en">EN</title>')}</tv>`, { language: 'en' }),
  xml(`<tv>${prog('<title lang="fr">FR</title><title lang="de">DE</title>')}</tv>`),
  xml(`<tv>${prog('<title lang="fr-FR">FRFR</title><title lang="fr">FR</title>')}</tv>`, { language: 'fr' }),
  xml(`<tv>${prog('<title lang="fr-FR">FRFR</title><title lang="en">EN</title>')}</tv>`, { language: 'fr' }),
  xml(`<tv>${prog('<title lang="EN">upper</title>')}</tv>`, { language: 'en' }),
  xml(`<tv>${prog('<title>T</title><sub-title lang="fr">S fr</sub-title><sub-title>S</sub-title><desc lang="en">D en</desc><desc lang="fr">D fr</desc>')}</tv>`, { language: 'fr' }),
  xml(`<tv>${prog('<title>T</title><episode-num system="onscreen">S03E07</episode-num>')}${prog('<title>T</title><episode-num system="onscreen">s01e05</episode-num>')}${prog('<title>T</title><episode-num>1x05</episode-num>')}${prog('<title>T</title><episode-num system="onscreen">E12</episode-num>')}${prog('<title>T</title><episode-num system="onscreen">  7  </episode-num>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><episode-num system="xmltv_ns">0.2.0/1</episode-num>')}${prog('<title>T</title><episode-num system="xmltv_ns"> 3 / 5 . 11 . </episode-num>')}${prog('<title>T</title><episode-num system="xmltv_ns">x.y</episode-num>')}${prog('<title>T</title><episode-num system="xmltv_ns">.4</episode-num>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><episode-num system="dd_progid">EP1</episode-num><episode-num system="DD_PROGID">EP2</episode-num><episode-num system="onscreen"></episode-num><episode-num system="xmltv_ns">1.1.</episode-num><episode-num system="onscreen">S9E9</episode-num>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><rating system="x"><value>PG</value></rating><star-rating><value>9/10</value></star-rating>')}${prog('<title>T</title><star-rating><value>9/10</value></star-rating>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><date>19ab-05-05</date>')}${prog('<title>T</title><date>abc</date>')}${prog('<title>T</title><date>2026</date>')}${prog('<title>T</title><date></date>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><new/><live/>')}${prog('<title>T</title><new></new>')}${prog('<title>T</title><new-x/>')}${prog('<title>T</title><NEW />')}${prog('<title>T</title><Live>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><category>A</category><category> </category><category>B &amp; C</category>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><icon src="http://a/1.png"/><icon src="http://a/2.png"/>')}${prog('<title>T</title><icon/>')}</tv>`),
  xml(`<tv>${prog('<title>a &amp;lt; b</title>')}${prog('<title>a &#38;lt; b</title>')}${prog('<title>&#x110000; &#xFFFFFF; &#99999999; &#65; &#x41;</title>')}${prog('<title>a&nbsp;b &custom; &Amp; &AMP;</title>')}${prog('<title><![CDATA[x &amp; y <b>]]></title>')}</tv>`),
  xml(`<tv>${prog('<title>T</title><desc><![CDATA[a </programme> b]]></desc>')}${prog('<title>T2</title>')}</tv>`),
  xml('<?xml version="1.0"?><!DOCTYPE tv [ <!ENTITY a "expanded"> ]><tv>' + prog('<title>x &a; y</title>') + '</tv>'),
  xml(`<tv>${prog('<title>T</title>', 'start = "20260914183000 +0000"  channel =  "a" stop="20260914190000"')}</tv>`),
  xml(`<tv>${prog('<title>Unclosed</title>')}<programme start="20260914183000 +0000" channel="a"><title>Tail</title>`),
  xml('<tv><programme start="20260914183000 +0000" channel="a"><title>Self</title></programme><programme start="20260914183000 +0000" channel="a"/></tv>'),
  xml(`<tv>${prog('<title>T</title>', 'start="20260914183000" stop="20260914190000 -0130" channel="a"')}</tv>`, { offsetMinutes: -120 }),
  xml(`<tv>${prog('<title>T</title>', 'start="202609141830" channel="a"')}${prog('<title>T</title>', 'start="20260914183000 junk" channel="a"')}${prog('<title>T</title>', 'start="  20260914183000  " channel="a"')}</tv>`),
  xml(`<tv>${prog('<title>Multi\nline</title><desc>  spaced  </desc>')}</tv>`),
  xml(`<tv><programme start="20260914183000 +0000" channel="a"><title>Tab\there</title></programme></tv>`),
  xml(`<tv>${prog('<title>é à 日本 😀</title>')}</tv>`),
  xml(`<tv>${prog('<title>T</title>', 'start="20260914183000 +0000" channel="a&amp;b"')}</tv>`),
  xml(''),
  xml('not xml at all'),
];

const dateCases: [string | null, number][] = [
  ['20260914183000 +0200', 0], ['20260914183000', 120], ['202609141830', 0], ['soon', 0], [null, 0], ['20260914183000 -0530', 0], ['  20260914183000+0100  ', 0], ['20260914183000 +0100 trailing', 0], ['2026091418300', 0], ['20260914183000 +9999', 0], ['20260914183000 0200', 0], ['', 0], ['20240229120000', 0], ['20260914183000', -90],
];
const decodeCases = ['<![CDATA[a & b]]>', '&#x41;&#66;&amp;', '&#xFFFFFF;', '&#99999999;', 'ok &#65; &#xFFFFFF; end', '&amp;lt;', '&#38;lt;', '&lt;&gt;&quot;&apos;&nbsp;', '&unknown;', '  padded  ', '<![CDATA[x &amp; y]]> &amp;', '<![CDATA[a]]><![CDATA[b]]>', '&#x;', '&#;', '&;', '&amp', 'a &AMP; b', ' x ', '﻿x'];

const matchInputs: unknown[] = [];
{
  const candidates = [
    { id: 'one.fr', displayNames: ['One'] },
    { id: 'sport.fr', displayNames: ['Sport One', 'Sport 1'] },
    { id: 'news.fr', displayNames: ['World News Channel'] },
  ];
  const ch = (id: number, name: string, guideChannelId: string | null = null, guideMatchKind: string | null = null) => ({ id, name, guideChannelId, guideMatchKind });
  const m = (channels: unknown[], cands: unknown[] = candidates) => ({ fn: 'matchGuideChannels', channels, candidates: cands });
  matchInputs.push(
    m([ch(1, 'Whatever', 'ONE.FR')]),
    m([ch(2, 'FR: Sport One FHD')]),
    m([ch(3, 'World News Channel Europe')]),
    m([ch(4, 'Cooking Plus')]),
    m([ch(5, 'One', 'sport.fr', 'manual')]),
    m([ch(1, 'x', 'one.fr'), ch(2, 'Sport One'), ch(4, 'Cooking Plus')]),
    m([ch(1, 'Dup')], [{ id: 'dup', displayNames: ['Dup'] }, { id: 'DUP', displayNames: ['Other'] }]),
    m([ch(1, 'x', 'DUP')], [{ id: 'dup', displayNames: [] }, { id: 'DUP', displayNames: [] }]),
    m([ch(1, 'red green blue')], [{ id: 'a', displayNames: ['red green blue yellow'] }, { id: 'b', displayNames: ['red green blue purple'] }]),
    m([ch(1, 'red green blue')], [{ id: 'b', displayNames: ['red green blue purple'] }, { id: 'a', displayNames: ['red green blue yellow'] }]),
    m([ch(1, ''), ch(2, '   ')], [{ id: 'e', displayNames: [''] }, { id: '', displayNames: ['x'] }]),
    m([ch(1, 'x', '')], candidates),
    m([ch(1, 'a b c d'), ch(2, 'a b c'), ch(3, 'a b')], [{ id: 'z', displayNames: ['a b c d e'] }]),
    m([ch(1, 'Canal+ Décalé')], [{ id: 'c', displayNames: ['canal decale'] }, { id: 'd', displayNames: ['canal+ decale'] }]),
    m([ch(1, 'x')], []),
    m([], candidates),
  );
  const rng = mulberry32(99);
  const words = ['alpha', 'beta', 'gamma', 'delta', 'sport', 'news', 'kids', 'hd', 'fr:', '+', 'one'];
  const phrase = () => Array.from({ length: ri(rng, 1, 4) }, () => pick(rng, words)).join(' ');
  for (let i = 0; i < 25; i++) {
    const cands = Array.from({ length: ri(rng, 1, 12) }, (_, k) => ({ id: pick(rng, [`c${k}`, `C${ri(rng, 0, 5)}`, phrase()]), displayNames: Array.from({ length: ri(rng, 0, 3) }, phrase) }));
    const chans = Array.from({ length: ri(rng, 1, 10) }, (_, k) => ch(k + 1, phrase(), rng() < 0.3 ? pick(rng, cands).id.toUpperCase() : null, rng() < 0.15 ? 'manual' : null));
    matchInputs.push(m(chans, cands));
  }
  const rows = (spec: [string, number][]) => spec.map(([g, s], i) => ({ guideChannelId: g, guideSourceId: s, title: `r${i}` }));
  const p = (spec: [string, number][], prio: [number, number][]) => ({ fn: 'pickHighestPriorityRows', rows: rows(spec), priorities: prio });
  matchInputs.push(
    p([['x', 1], ['x', 2], ['y', 2]], [[1, 0], [2, 5]]),
    p([['x', 1], ['x', 2]], [[1, 1]]),
    p([['x', 5], ['x', 2]], []),
    p([['a', 1], ['b', 2]], []),
    p([['x', 1], ['x', 2], ['x', 1], ['x', 3]], [[1, 2], [2, 2], [3, 9]]),
    p([['x', 1], ['x', 1]], []),
    p([['x', 3], ['x', 2], ['x', 3]], [[3, -1], [2, -1]]),
    p([], []),
  );
}

// ---- run ----------------------------------------------------------------------------------

async function collect(text: string, options: { offsetMinutes?: number; language?: string }) {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];
  await parseXmltvStream(
    Readable.from([text]),
    { onChannel: (c) => { channels.push(c); }, onProgramme: (p) => { programmes.push(p); } },
    options,
  );
  return { channels, programmes };
}

const pat = (p: string | null, field: string) => compileGroupPattern(p, field);

async function run(i: any): Promise<unknown> {
  switch (i.fn) {
    case 'parseM3u': return parseM3u(i.text);
    case 'deriveExternalId': return deriveExternalId({}, i.url, i.name);
    case 'isOnDemandUrl': return isOnDemandUrl(i.url);
    case 'normalizeGroupName': return normalizeGroupName(i.raw);
    case 'foldGroupKey': return foldGroupKey(i.raw);
    case 'normalizeChannelName': return normalizeChannelName(i.raw);
    case 'nameSimilarity': return nameSimilarity(i.a, i.b);
    case 'classifyEntries': {
      const r = classifyEntries(i.entries, pat(i.include, 'i'), pat(i.exclude, 'e'));
      return { live: r.live.map((e) => e.url), onDemandCount: r.onDemandCount, groups: r.groups };
    }
    case 'liveTvAccountStateOf': return liveTvAccountStateOf(i.expiresAt ? new Date(i.expiresAt) : null, i.status, new Date(i.now));
    case 'detectXtreamFromUrl': return detectXtreamFromUrl(i.raw);
    case 'detectXtreamFromStreamUrl': return detectXtreamFromStreamUrl(i.raw);
    case 'xtreamPlaylistUrl': return xtreamPlaylistUrl(i.creds);
    case 'pickOutputFormat': return pickOutputFormat(i.allowed);
    case 'xtreamAccount': {
      const client: any = new XtreamClient({ baseUrl: 'http://h', username: 'u', password: 'p' });
      client.call = async () => i.data;
      try { return await client.account(); } catch (e) { return { error: (e as Error).message.startsWith('authentication') ? 'auth' : 'other' }; }
    }
    case 'xtreamLiveStreams': {
      const client: any = new XtreamClient({ baseUrl: 'http://h', username: 'u', password: 'p' });
      client.call = async (action: string) => (action === 'get_live_categories' ? i.categories : i.streams);
      try {
        return (await client.liveStreams()).map(({ archiveDays: _a, ...rest }: any) => rest);
      } catch { return { error: 'list' }; }
    }
    case 'parseXmltvStream': return collect(i.xml, { offsetMinutes: i.offsetMinutes, language: i.language });
    case 'parseXmltvDate': return parseXmltvDate(i.raw ?? undefined, i.offset);
    case 'decodeXmlText': return decodeXmlText(i.raw);
    case 'matchGuideChannels': return matchGuideChannels(i.channels, i.candidates);
    case 'pickHighestPriorityRows': return pickHighestPriorityRows(i.rows, new Map(i.priorities));
    default: throw new Error(`unknown fn ${i.fn}`);
  }
}

const inputs: unknown[] = [
  ...m3uInputs,
  ...ID_CASES.map(([url, name]) => ({ fn: 'deriveExternalId', url, name })),
  ...OD_CASES.map((url) => ({ fn: 'isOnDemandUrl', url })),
  ...GROUP_CASES.map((raw) => ({ fn: 'normalizeGroupName', raw })),
  ...GROUP_CASES.filter((g) => g !== null).map((raw) => ({ fn: 'foldGroupKey', raw })),
  ...names,
  ...classifyInputs,
  ...states,
  ...xtream,
  ...xmltv,
  ...dateCases.map(([raw, offset]) => ({ fn: 'parseXmltvDate', raw, offset })),
  ...decodeCases.map((raw) => ({ fn: 'decodeXmlText', raw })),
  ...matchInputs,
];

void emit('livetv-parsing', inputs, run);
