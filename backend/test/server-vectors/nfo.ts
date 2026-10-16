import { NfoMetadataService } from '../../src/modules/imports/nfo-metadata.service';
import { emit, mulberry32, pick, ri } from './_util';

const svc = new NfoMetadataService();
const rng = mulberry32(0x3f0);
const doc = (xml: string) => ({ fn: 'parse', xml });

const spec: unknown[] = [
  doc(`<?xml version="1.0" encoding="UTF-8"?><movie><title>Sample Movie</title><originaltitle>Orig</originaltitle><year>2009</year><plot>A plot.</plot><outline>Short.</outline><genre>Drama</genre><genre>Mystery</genre><genre>Drama</genre><runtime>118</runtime><ratings><rating name="imdb" default="true"><value>7.6</value><votes>1200</votes></rating><rating name="tmdb"><value>7.2</value></rating></ratings><premiered>2009-05-14</premiered><uniqueid type="tmdb">1234</uniqueid><uniqueid type="imdb">tt0001234</uniqueid></movie>`),
  doc('<movie><outline>Only an outline.</outline></movie>'),
  doc('<tvshow><showtitle>Sample Show</showtitle><year>2015</year><genre>Comedy</genre><id>556677</id></tvshow>'),
  doc('<movie><ratings><rating name="tmdb"><value>5.5</value></rating></ratings></movie>'),
  doc('<movie><rating>8.1</rating></movie>'), doc('<movie><rating>42</rating></movie>'), doc('<movie><rating>7,5</rating></movie>'),
  doc('<movie><premiered>2012-01-09</premiered></movie>'),
  doc('not xml at all'), doc('<<<>>>garbage&&&'), doc(''), doc('<movie><title>X'), doc('<Title>X</Title>'),
  doc('<m><uniqueid type="tmdb">0</uniqueid><uniqueid type="tmdb">12</uniqueid><tmdbid>99</tmdbid></m>'),
  doc('<m><uniqueid type="tmdb">abc</uniqueid><uniqueid type="tmdb">7</uniqueid></m>'),
  doc('<m><tmdbid>0</tmdbid></m>'), doc('<m><uniqueid type="tmdb">0</uniqueid></m>'), doc('<m><tmdbid>5</tmdbid><uniqueid type="tmdb">6</uniqueid></m>'),
  doc('<m><id>tt123</id></m>'), doc('<m><id>456</id></m>'), doc('<m><id>12abc</id></m>'), doc('<m><id>tt1</id><uniqueid type="imdb">tt2</uniqueid></m>'),
  doc('<m><uniqueid type="TVDB">9</uniqueid><uniqueid>5</uniqueid><uniqueid type="imdb"> tt7 </uniqueid></m>'),
  doc('<m><year>12abc</year></m>'), doc('<m><year>-5</year></m>'), doc('<m><runtime>0</runtime></m>'), doc('<m><runtime>90 min</runtime></m>'),
  doc('<m><premiered>2020-13-45</premiered></m>'), doc('<m><premiered>2020-01-00</premiered></m>'), doc('<m><premiered>2020-02-30</premiered></m>'), doc('<m><premiered>2021-02-29</premiered></m>'),
  doc('<m><aired>2019-05-06T00:00</aired></m>'), doc('<m><premiered> </premiered><aired>2018-01-02</aired></m>'), doc('<m><premiered>2020-13-45</premiered></m>'),
  doc('<m><title><![CDATA[A <b> & C]]></title><plot>x &lt; y &#65; &amp;amp;</plot></m>'), doc('<a><title>one</b>two</title></a>'),
  doc('<t><showtitle>Show</showtitle><title>Ep</title></t>'), doc('<t><showtitle></showtitle><title>Ep</title></t>'),
  doc('<m><genre>A</genre><genre></genre><genre> B </genre></m>'), doc('<m><genre/></m>'),
  doc('<m><ratings><rating default="true"><value></value></rating><rating><value>6</value></rating></ratings></m>'),
  doc('<m><originaltitle>Orig</originaltitle><outline>o</outline><plot></plot></m>'),
  doc('<m><title>a</title><title>b</title></m>'), doc('<outer><inner><title>deep</title></inner></outer>'),
];
const specCount = spec.length;

const TAGS: Array<() => string> = [
  () => `<title>${pick(rng, ['Heat', 'A &amp; B', '', ' x ', '<![CDATA[c]]>'])}</title>`,
  () => `<showtitle>${pick(rng, ['Show', ''])}</showtitle>`,
  () => `<originaltitle>${pick(rng, ['O', ''])}</originaltitle>`,
  () => `<year>${pick(rng, ['1999', '2020x', '0', '-3', '', ' 7 '])}</year>`,
  () => `<runtime>${pick(rng, ['90', '0', 'x', '1h'])}</runtime>`,
  () => `<plot>${pick(rng, ['p', '', 'a &lt; b'])}</plot>`, () => `<outline>${pick(rng, ['o', ''])}</outline>`,
  () => `<genre>${pick(rng, ['Drama', 'Comedy', ''])}</genre>`,
  () => `<rating>${pick(rng, ['7.5', '7,5', '11', '-1', 'x', '0', ''])}</rating>`,
  () => `<ratings><rating${pick(rng, ['', ' default="true"'])}><value>${pick(rng, ['8', '9,5', '12', ''])}</value></rating></ratings>`,
  () => `<premiered>${pick(rng, ['2020-01-02', '2020-13-01', '1999-12-31T10:00', 'x', '2020-02-31', '2020-1-2'])}</premiered>`,
  () => `<aired>${pick(rng, ['2019-03-04', '2019-00-04', ''])}</aired>`,
  () => `<uniqueid type="${pick(rng, ['tmdb', 'TMDB', 'tvdb', 'imdb', 'other', ''])}">${pick(rng, ['12', '0', 'abc', 'tt9', ' 5 ', ''])}</uniqueid>`,
  () => `<tmdbid>${pick(rng, ['3', '0', 'z'])}</tmdbid>`, () => `<tvdbid>${pick(rng, ['4', '0'])}</tvdbid>`, () => `<imdbid>${pick(rng, ['tt5', ' ', ''])}</imdbid>`,
  () => `<id>${pick(rng, ['tt6', '77', 'x1', ''])}</id>`,
];
const gen: unknown[] = [];
for (let n = 0; n < 300; n++) {
  const body = Array.from({ length: ri(rng, 1, 9) }, () => pick(rng, TAGS)()).join('');
  gen.push(doc(`<${pick(rng, ['movie', 'tvshow', 'episodedetails'])}>${body}${rng() < 0.15 ? '' : '</movie>'}`));
}

(async () => {
  const all = [...spec, ...gen];
  await emit('nfo', all, (i: any) => svc.parse(i.xml));
  console.log(`nfo total=${all.length} spec=${specCount}`);
})();
