import {
  applyPathMapping,
  hearingImpairedFromTags,
  parseLanguageFromPath,
  parseSubtitleTags,
  suggestLocalLibraryId,
} from '../../src/modules/scheduler/utils/arr-import.util';
import { ImportRadarrService } from '../../src/modules/imports/radarr.service';
import { ImportSonarrService } from '../../src/modules/imports/sonarr.service';
import { SeerrRequestImportService } from '../../src/modules/imports/seerr-request-import.service';
import { emit, mulberry32, pick, ri } from './_util';

const rng = mulberry32(0x5a11);
const radarr: any = Object.create(ImportRadarrService.prototype);
const sonarr: any = Object.create(ImportSonarrService.prototype);
const seerr: any = Object.create(SeerrRequestImportService.prototype);

const apm = (path: unknown, mappings: object[]) => ({ fn: 'applyPathMapping', path, mappings });
const sug = (remote: unknown, libs: object[]) => ({ fn: 'suggestLocalLibraryId', remote, libs });
const lang = (path: string) => ({ fn: 'parseLanguageFromPath', path });
const tags = (path: string) => ({ fn: 'parseSubtitleTags', path });
const items = (items: unknown, svc = 'radarr') => ({ fn: 'mapRemoteItems', items, svc });
const cutoff = (cutoffId: unknown, items: unknown, svc = 'radarr') => ({ fn: 'resolveCutoff', cutoffId, items, svc });
const quality = (name: string) => ({ fn: 'findLocalQuality', name });
const status = (request: unknown, media: unknown) => ({ fn: 'mapStatus', request, media });

const M = (remotePath: string, localLibraryId: number | null, ignore?: boolean) => ({ remotePath, localLibraryId, ...(ignore ? { ignore } : {}) });
const spec: unknown[] = [
  apm('/data/tv/Show (2020)', [M('/data', 1), M('/data/tv', 2)]),
  apm('/data/movies/X', [M('/data', 1), M('/data/tv', 2)]),
  apm('/other/x', [M('/data', 1)]),
  apm('/data/tvx/y', [M('/data/tv', 2), M('/data', 1)]),
  apm('/a/b/x', [M('/a/b', null), M('/a', 1)]),
  apm('/z/x', [M('/z', 1, true)]),
  apm('/a/b', [M('/a', 1)]),
  apm('/a', [M('/a', 1)]),
  apm('/q/x', [M('/', 1)]),
  apm('  ', [M('/a', 1)]),
  apm(null, [M('/a', 1)]),
  apm('/a/x', []),
  apm('D:\\Movies\\X (1999)', [M('D:\\Movies', 1)]),
  apm('D:\\Movies\\X (1999)\\', [M('D:/Movies/', 1)]),
  apm('/movies/..\\x', [M('/movies', 2)]),
  apm('/movies/..\\', [M('/movies', 2)]),
  apm('/movies/..\\..\\etc', [M('/movies', 2)]),
  apm('/movies/.\\x', [M('/movies', 2)]),
  apm('/movies//a//b/', [M('/movies/', 2)]),
  apm('/a/../b/c', [M('/b', 1)]),
  apm('relative/path/x', [M('relative', 1)]),
  apm(' /a/x ', [M(' /a ', 1)]),
  sug('/data/movies', [{ id: 1, path: '/media/movies' }, { id: 2, path: '/media/tv' }, { id: 3, path: null }]),
  sug('/data/anime', [{ id: 1, path: '/media/movies' }]),
  sug('/x/tv', [{ id: 1, path: '/a/tv' }, { id: 2, path: '/b/tv' }]),
  sug('tv', [{ id: 2, path: '/media/tv' }]),
  sug('  ', [{ id: 2, path: '/media/tv' }]),
  sug('/x/tv', []),
  sug('/', [{ id: 1, path: '/media/tv' }]),
  sug('C:\\Media\\Movies', [{ id: 1, path: '/srv/Movies' }, { id: 2, path: '/srv/movies' }]),
  sug('/x/tv', [{ id: 1, path: 'tv' }]),
  ...['Movie.fra.forced.srt', 'Movie.EN.srt', 'Movie.srt', 'a/b/Movie.en.fr.srt', 'Movie.eng.srt', 'Movie.zho.sdh.srt', 'Movie.de-DE.srt', 'Subs/Movie.pt.srt', 'en.srt', '.en.srt', 'Movie.xx.srt', 'Movie.en'].map(lang),
  ...['M.en.forced.srt', 'M.en.SDH.srt', 'M.en.hi.srt', 'M.en.cc.srt', 'Archive.srt', 'M_hi.srt', 'M.shift.srt', 'M.forcedx.srt', 'Machine.srt', 'M.en.forced.sdh.srt', 'M.en.SDH.srt.bak', 'dir.hi/M.srt'].map(tags),
];
const q = (id: number, name: string) => ({ quality: { id, name } });
const profile = [
  { ...q(7, 'Bluray-1080p'), allowed: true },
  { name: 'WEB 720p', allowed: false, items: [{ ...q(5, 'WEBDL-720p'), allowed: true }, { ...q(14, 'WEBRip-720p'), allowed: false }] },
  { ...q(1, 'Unknown'), allowed: true },
  { ...q(4, 'HDTV-720p'), allowed: false, items: [{ ...q(4, 'HDTV-720p'), allowed: true }] },
  { allowed: true },
];
spec.push(items([]), items(profile), items(profile, 'sonarr'), items([{ ...q(3, 'WEBDL-1080p'), allowed: true }, { ...q(9, 'WEB-DL 1080p'), allowed: true }]));
spec.push(items([{ quality: { name: 'bluray_1080p' }, allowed: true }]), items([{ quality: {}, allowed: true }, { quality: { name: '' }, allowed: true }]));
for (const id of [7, 5, 14, 4, 99, 1, null, 0]) spec.push(cutoff(id, profile), cutoff(id, profile, 'sonarr'));
spec.push(cutoff(7, []), cutoff(7, [{ quality: { id: 7, name: 'Nope' } }]), cutoff(1, [{ quality: { id: 1, name: '' } }]));
for (const n of ['WEBDL-1080p', 'web dl 1080p', 'Bluray_2160p', 'Remux-1080p', 'Raw-HD', 'HDTV-720p', 'x', 'DVD', 'WEBRip 480p', '']) spec.push(quality(n));
for (const r of [1, 2, 3, 4, 5, 0, undefined, null]) for (const m of [undefined, null, 0, 1, 2, 3, 4, 5, 6]) spec.push(status(r, m));
const specCount = spec.length;

const SEG = ['data', 'tv', 'movies', 'a', 'b', 'x y', '..', '.', '..\\x', 'Show (2020)', 'D:', 'é', ''];
const mkPath = () => (rng() < 0.2 ? '' : '/') + Array.from({ length: ri(rng, 1, 5) }, () => pick(rng, SEG)).join(rng() < 0.15 ? '\\' : '/') + (rng() < 0.2 ? '/' : '');
const gen: unknown[] = [];
for (let n = 0; n < 250; n++) {
  gen.push(apm(rng() < 0.05 ? null : mkPath(), Array.from({ length: ri(rng, 0, 4) }, () => M(mkPath(), rng() < 0.2 ? null : ri(rng, 1, 3), rng() < 0.2))));
}
for (let n = 0; n < 60; n++) gen.push(sug(mkPath(), Array.from({ length: ri(rng, 0, 4) }, () => ({ id: ri(rng, 1, 9), path: rng() < 0.15 ? null : mkPath() }))));
const LSEG = ['Movie', 'en', 'fr', 'eng', 'fra', 'forced', 'sdh', 'cc', 'hi', 'EN', 'zh', 'xx', 'srt', 'Show', 'S01E01'];
for (let n = 0; n < 120; n++) {
  const p = Array.from({ length: ri(rng, 1, 5) }, () => pick(rng, LSEG)).join(pick(rng, ['.', '.', '_', ' '])) + '.srt';
  gen.push(lang(p), tags(p));
}

const run = (i: any) => {
  switch (i.fn) {
    case 'applyPathMapping': return applyPathMapping(i.path, i.mappings) ?? null;
    case 'suggestLocalLibraryId': return suggestLocalLibraryId(i.remote, i.libs);
    case 'parseLanguageFromPath': return parseLanguageFromPath(i.path);
    case 'parseSubtitleTags': { const t = parseSubtitleTags(i.path); return { tags: t, hearingImpaired: hearingImpairedFromTags(t) }; }
    case 'mapRemoteItems': return (i.svc === 'radarr' ? radarr : sonarr).mapRemoteItems(i.items);
    case 'resolveCutoff': return (i.svc === 'radarr' ? radarr : sonarr).resolveCutoff(i.cutoffId, i.items);
    case 'findLocalQuality': return radarr.findLocalQuality(i.name)?.id ?? null;
    default: return seerr.mapStatus(i.request, i.media);
  }
};

(async () => {
  const all = [...spec, ...gen];
  await emit('arr-import', all, run);
  console.log(`arr-import total=${all.length} spec=${specCount}`);
})();
