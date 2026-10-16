import { pick, ri } from './_util';

// Characters where a JS pattern without the `u` flag and Rust's Unicode default disagree.
export const DIVERGENCE = ['K', 'ſ', 'İ', 'Σ', 'ς', '٣', '٠', '٩', '１', '５', ' ', '﻿', '\u0085', ' ', 'É', 'é', 'à'];

// Applies one divergence substitution or glue to a random spot of `s`.
export function diverge(rng: () => number, s: string): string {
  const swap = (re: RegExp, to: string) => {
    const hits = [...s.matchAll(re)];
    if (!hits.length) return s;
    const at = pick(rng, hits).index!;
    return s.slice(0, at) + to + s.slice(at + 1);
  };
  switch (ri(rng, 0, 7)) {
    case 0: return swap(/[sS]/g, 'ſ');
    case 1: return swap(/[kK]/g, 'K');
    case 2: return swap(/[iI]/g, 'İ');
    case 3: return swap(/\d/g, pick(rng, ['٣', '٠', '٩', '１', '５']));
    case 4: return swap(/[. _-]/g, pick(rng, [' ', '﻿', '\u0085', ' ']));
    case 5: return pick(rng, ['É', 'é', 'à', 'Σ']) + s;
    case 6: return s + pick(rng, ['É', 'é', 'ς', 'ß']);
    default: { const at = ri(rng, 0, s.length); return s.slice(0, at) + pick(rng, DIVERGENCE) + s.slice(at); }
  }
}

export const maybeDiverge = (rng: () => number, s: string, p = 0.25) => (rng() < p ? diverge(rng, s) : s);

export const WORDS = ['Show', 'Show.Name', 'The.Movie', 'Nova Skyline', 'Nova.Skyline', "L'Impossible", 'Éclair', 'Lonely_Harbor', 'No.Country.for.Old.Men', 'Spy-Fi', 'Kaiju Kings'];
export const NOISE = ['1080p', 'x265', '5.1', '10bit', '2019-2020', 'DDP5.1', 'WEB-DL', 'BluRay', 'FRENCH', 'MULTI', 'HDR', 'PROPER', '2160p'];
export const SEPS = ['.', ' ', '_', '-'];

// A corpus of realistic release names reused by the scoring and custom-format sets.
export const RELEASES = [
  'The.Movie.2020.1080p.BluRay.x264-GRP', 'The.Movie.2020.2160p.UHD.BluRay.REMUX.HDR.HEVC-GRP', 'Show.S02E03.720p.HDTV.x264-GRP',
  'Show.S02E03.WEBRip.x264-GRP', 'Show.S02E03.WEB.DL.1080p.AAC', 'Show.S02E03.2160p.HDR.HEVC-GRP', 'Movie.2019.CAM.XviD', 'Movie.2019.TS.x264',
  'Movie.2019.DVDRip.XviD', 'Movie.2019.BDRip.x264', 'Movie.2019.4K.WEBRip', 'Nova.Skyline.2.2015.1080p.BluRay.x264-GRP', 'Nova.Skyline.2015.1080p.BluRay',
  'Nova.Skyline.Collection.1080p.BluRay', 'Nova.Skyline.Trilogy.2010-2015.1080p', 'Show.S01.1080p.WEB-DL.x265-GRP', 'Show.S01-S04.1080p.WEB-DL',
  'Show.Complete.Series.1080p', 'Show.S01E04E05.1080p', 'Show.1x04-05.DVDRip', 'Show.S01E04.FRENCH.1080p.WEB-DL.DDP5.1.x265-GRP', "L'Impossible.2012.FRENCH.1080p.BluRay",
  'Éclair.2010.MULTI.720P.WEB-DL', 'Movie.2019.GERMAN.DL.1080p.BluRay', 'Movie.2019.ITA.ENG.1080p', 'Movie.2019.VOSTFR.1080p', 'No.Country.for.Old.Men.2007.1080p.BluRay',
  'Spirited.Away.2001.JAPANESE.1080p', 'Movie.2019.Directors.Cut.1080p.BluRay.DTS-HD.MA-GRP', 'Movie.2019.IMAX.2160p.WEB-DL.DDP5.1.Atmos.H.265-GRP', 'Movie.2019.Extended.720p.HDTV.AC3',
  'Movie.2019.1080p.WEB-DL.x264.AAC-GRP.mkv', 'Show - 03 [1080p].mkv', '[SubsPlease] Show S2 - 04 (1080p)', 'Movie 2019 1080p Remux', 'Movie_2019_1080p_BluRay', 'Movie-2019-2160p-WEBRip',
  'ΣΑΣ.2010.1080p.WEB-DL', 'İstanbul.2010.1080p', 'Show.Name.2022.S01E01.1080p', 'Show.E01-E12.1080p', 'Show.1920x1080.WEB', 'Show.S05x265.1080p', 'no quality here', '1917.2019.1080p',
  'Movie.2019.HDRip.x264.SDH', 'Movie.2019.1080p.CC.WEB', 'Movie.2019.1080p.Hearing.Impaired', 'Movie.2019.FRENCH.TrueFrench.1080p', 'Movie.2019.1080p.NL.WEB', 'Movie.2019.1080p.PL.WEB',
];
