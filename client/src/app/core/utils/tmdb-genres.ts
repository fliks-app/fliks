/**
 * Resolve a genre *name* to its TMDB genre id, language-independently.
 *
 * Taste-profile chips carry genre names captured on the media at add time,
 * which may be English ("Drama") on older items or French ("Drame") on newer
 * ones (TMDB is queried in fr-FR today). The discover panel filters by genre
 * id, and TMDB ids are stable across languages — so we map the name to an id
 * through a normalized EN/FR alias table rather than matching display strings.
 *
 * Ids target the movie catalogue (the discover grid's default); TV-only genres
 * map to their closest movie equivalent so a chip always yields a usable
 * filter. A caller can pass a live genre list (e.g. the fr-FR list fetched from
 * TMDB) as a fallback for names the static table doesn't cover.
 */

/** Lowercase, strip accents, drop separators — so "Science-Fiction",
 *  "Science Fiction" and "science fiction" all collapse to one key. */
function normalizeGenre(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Normalized EN + FR genre name → TMDB id. */
const GENRE_ALIASES: Record<string, number> = {
  // Movie genres (EN / fr-FR)
  action: 28,
  adventure: 12,
  aventure: 12,
  animation: 16,
  comedy: 35,
  comedie: 35,
  crime: 80,
  documentary: 99,
  documentaire: 99,
  drama: 18,
  drame: 18,
  family: 10751,
  familial: 10751,
  fantasy: 14,
  fantastique: 14,
  history: 36,
  histoire: 36,
  horror: 27,
  horreur: 27,
  music: 10402,
  musique: 10402,
  mystery: 9648,
  mystere: 9648,
  romance: 10749,
  sciencefiction: 878,
  thriller: 53,
  tvmovie: 10770,
  telefilm: 10770,
  war: 10752,
  guerre: 10752,
  western: 37,
  // TV-only genres → closest movie equivalent so the chip still filters
  actionadventure: 28,
  actionaventure: 28,
  scififantasy: 878,
  sciencefictionfantastique: 878,
  warpolitics: 10752,
  guerrepolitique: 10752,
  kids: 10751,
  enfants: 10751,
};

export function resolveTmdbGenreId(
  name: string,
  fallbackList: { id: number; name: string }[] = [],
): number | null {
  const key = normalizeGenre(name);
  if (GENRE_ALIASES[key] != null) return GENRE_ALIASES[key];
  const match = fallbackList.find((g) => normalizeGenre(g.name) === key);
  return match?.id ?? null;
}
