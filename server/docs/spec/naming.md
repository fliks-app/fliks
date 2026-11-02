# Spec: naming

Scope: pure string logic for `fliks_domain::naming` plus one settings read in `crates/server`. No route, no event, no job. Release parsing (`release.md`) is separate: naming has its own, looser episode parser (rule 16) and does not call it.

## Routes

none. Callers:

| Function | Rust owner |
|---|---|
| `get_formats` | ingest, importers specs |
| `apply_movie_format`, `apply_series_format`, `apply_season_folder_format`, `extract_release_group` | ingest spec |
| `apply_movie_folder_format`, `apply_series_folder_format` | media write spec, importers spec |
| `parse_episode_numbers` | rescan, importers, ingest |
| `is_special_file` | importers |
| `match_special_by_title` | rescan, importers, ingest |

## Rules

### A. API and reading the formats

1. Public API (`fliks_domain::naming`, pure; fixture JSON uses camelCase field names):
   ```rust
   pub struct NamingFormats { pub movie: String, pub movie_folder: String, pub series: String, pub series_folder: String, pub season_folder: String, pub book: String, pub book_folder: String }
   pub fn default_formats() -> NamingFormats;
   pub enum Scope { File, Folder, GroupFolder }                              // Scope::ALL
   pub const fn setting_key(kind: MediaKind, scope: Scope) -> Option<&'static str>;
   pub fn formats_from_rows(rows: &[(String, Option<String>)]) -> NamingFormats;
   pub fn apply_movie_format(format: &str, d: &MovieFile) -> String;          // {title, originalTitle?, year?, quality, releaseGroup?, tmdbId?}
   pub fn apply_series_format(format: &str, d: &SeriesFile) -> String;        // {seriesTitle, season, episode, episodeTitle?, quality, releaseGroup?, airDate?}
   pub fn apply_movie_folder_format(format: &str, d: &MovieFolder) -> String; // {title, originalTitle?, year?, tmdbId?}
   pub fn apply_series_folder_format(format: &str, d: &SeriesFolder) -> String; // {seriesTitle, originalTitle?, year?, tmdbId?}
   pub fn apply_season_folder_format(format: &str, season: i64) -> String;
   pub fn apply_book_format(format: &str, d: &BookNameTokens) -> String;      // {title, author?, series?, seriesPosition?, year?, narrator?, language?, format?}
   pub fn extract_release_group(source_title: &str) -> String;
   pub fn parse_episode_numbers(source_title: &str, file_path: Option<&str>) -> Option<EpisodeNumbers>;  // {season, episode, episodeEnd?}
   pub fn is_special_file(path_or_name: &str) -> bool;
   pub fn match_special_by_title<T: HasTitle>(filename: &str, specials: &[T]) -> Option<usize>;
   ```
   and in `crates/server/src/naming.rs`: `pub async fn load_formats(pool: &PgPool) -> sqlx::Result<NamingFormats>` (rule 3). `episodeEnd` is absent (not null) when there is no range end.
2. Defaults (`default_formats()`): `movie` = `{Movie Title} ({Release Year}) {Quality Full}`; `movieFolder` = `{Movie Title} ({Release Year})`; `series` = `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}`; `seriesFolder` = `{Series Title}`; `seasonFolder` = `Season {season:00}`; `book` = `{Title} ({Year})`; `bookFolder` = `{Title}`.
3. `load_formats`: one query `SELECT key, value FROM app_settings WHERE key = ANY($1)` over the keys `setting_key` gives for every `(kind, scope)` of `MediaKind::ALL` × `Scope::ALL` (the seven keys of the table below); each field = the stored value, else the default when the row is absent OR its value is `NULL` (`??`); an empty string is a value and is kept (a format `''` renders `''`, so a movie file becomes `<ext>` only; callers guard). Read on demand on every call, no cache (a setting edited through `PUT /api/settings` applies to the next import; `settings.md` lists the keys as "read on demand").

### B. Formatting

4. Substitution mechanics: the format is rewritten by successive global replacements, in the order below, each replacing every occurrence of one exact, case-sensitive token (`{Movie Title}` is not `{movie title}`) by the value; the next replacement therefore also sees tokens that a previous value injected (a title that contains `{Release Year}` is expanded by a later step); finally `sanitize` (rule 7). Order: movie file: `{Movie Title}`, `{Original Title}`, `{Release Year}`, `{Quality Full}`, `{Quality Title}`, `{Release Group}`, `{TMDB Id}`, `{MediaInfo AudioCodec}`, `{MediaInfo VideoCodec}`. Series file: `{Series Title}`, `{season:00}`, `{episode:00}`, `{Episode Title}`, `{Quality Full}`, `{Quality Title}`, `{Release Group}`, `{Air Date}`, `{MediaInfo AudioCodec}`, `{MediaInfo VideoCodec}`. Movie folder: `{Movie Title}`, `{Original Title}`, `{Release Year}`, `{TMDB Id}`. Series folder: `{Series Title}`, `{Original Title}`, `{Release Year}`, `{TMDB Id}`. Season folder: `{season:00}`, `{season}`.
5. Values: `title`/`seriesTitle` `?? ''`; `{Original Title}` = `originalTitle || title` (series folder: `originalTitle || seriesTitle`), so an empty original falls back; `{Release Year}` = the year as a decimal string when truthy, else `''` (year `0` and null both empty); `{TMDB Id}` likewise (`0` empty); `{Quality Full}` and `{Quality Title}` both = `quality ?? ''`; `{Release Group}` = `releaseGroup ?? ''`; `{Episode Title}` = `episodeTitle ?? ''`; `{Air Date}` = `airDate ?? ''` (a string, no reformatting); `{season:00}` / `{episode:00}` = decimal string left-padded with `0` to width 2 and never truncated (`100` stays `100`, `-1` stays `-1`); `{season}` = the plain decimal string; both media-info tokens always `''`. A token not in the list for that function stays in the string until `sanitize` deletes it.
6. Movie and series FILE formats take the quality and release group; FOLDER formats do not (a `{Quality Full}` in a folder format is deleted by `sanitize`).
7. `sanitize(name)`, in this order: (1) delete every `{...}` (`\{[^}]*\}`, so a lone `{` or `}` survives); (2) delete the literal text `undefined` (case-sensitive, anywhere: `Undefined Behavior` keeps its capital, `undefinedx` loses it); (3) delete each of `< > : " / \ | ? *` and the code points U+0000-U+001F; (4) collapse runs of 2+ whitespace chars (`\s{2,}`) to one space; (5) delete `(` + optional whitespace + `)` and `[` + optional whitespace + `]` (empty groups only, one pass); (6) collapse 2+ whitespace again; (7) trim (JS whitespace, `js::trim`). One pass each: `((  ))` leaves `()`. A name that ends in `.` or contains a stray ` - ` is returned as is (the spec pins both as "invalid on Windows" and a leftover separator).
8. Pinned by the spec (each is a vector): year null drops the empty parentheses; empty quality trims the trailing space; empty episode title leaves ` - ` before the quality; a colon in a title is deleted (`Nova Skyline: Requiem` -> `Nova Skyline Requiem`); a slash is deleted and the double space it leaves is collapsed (`Nova / Skyline` -> `Nova Skyline`); a trailing dot stays; `undefined` after a token is stripped.
9. Values are substituted LITERALLY: a replacement pattern in a title (`$$`, `$&`, `` $` ``, `$'`, `$1`) is never interpreted, so `Money $$$` is named `Money $$$` and `A $& B` is unchanged (a title never embeds the token). Visible only for titles containing `$`, new imports only (existing folders keep their names). The `naming` vectors exclude `$` from generated values; a Rust unit test pins it.
10. (With `ingest.md` rule 3 and `importers.md` rule 36.) `apply_movie_folder_format` / `apply_series_folder_format` return the sanitized string as is and never map `.`, `..` or an empty result to `''`: `''` makes `Media.path` fall back to the bare library root (`ingest.md` rule 3), so a series or a movie named `''` would own the whole library folder (rescan, delete). Every `folderName` writer (TMDB import, importers, relink, `createUnmatched`, the `confirmImport` pin, Radarr/Sonarr path mapping) passes the result through the one `fliks_domain::naming` folder-name validator (`ingest.md` rule 3), which REJECTS a name that is empty, `.`, `..` or contains a separator or NUL (400 on a route, an `errors` entry in a batch); a title such as `..` or `???` therefore cannot be imported. The only empty name accepted is the explicit root-level movie of the relink and `createUnmatched` paths (the client sends `''` for a root-level group). The season folder needs no rule: `.` already joins to the show folder and `..` is refused by the ingest confinement (file skipped with an error). FILE formats always get an extension appended.

24. Book formats (`apply_book_format`; file and folder formats share one token set, the caller adds the extension and joins). Tokens, replaced in this order: `{Author}`, `{SeriesPosition}`, `{Series}`, `{Title}`, `{Year}`, `{Narrator}`, `{Language}`, `{Format}`. Values: `author`, `series`, `narrator`, `language` (ISO code) and `format` (the file extension without dot) are `?? ''`; `{SeriesPosition}` is the number as decimal text (`3`, `1.5`), empty when absent; `{Year}` follows rule 5; `title` `?? ''`. A format never receives a series folder: with a series, `{Series}` and `{SeriesPosition}` are tokens of the one component. Mechanics, `sanitize`, literal substitution and folder-name validation are rules 4, 7, 9 and 10 (the caller passes a folder result through the validator). Defaults leave out `{Author}`: an unknown author would leave a dangling ` - `. Vectors: `applyBookFormat`.

### C. Parsing

11. `extract_release_group(sourceTitle)`: first match of `-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$` (case-insensitive, so the extension class also takes upper case) on the raw title: group 1, else `''`. Underscores are not group characters here (unlike the attribute parser, `release.md` rule 15). Pinned: `...WEBDL-1080p.mkv` yields `1080p`; no dash yields `''`; the group keeps its case.
12. `parse_episode_numbers(sourceTitle, filePath?)` normalises first: `normalized = sourceTitle` with every `_` replaced by a space, then every `.` that is not followed by four ASCII digits replaced by a space (so a `.2023` stays). Each pattern below is tried on `normalized` first, then on the raw `sourceTitle` (`normalized.match(re) ?? sourceTitle.match(re)`), which is why `S01E05_06` loses its range end (the `_` is gone before the multi-episode pattern sees it).
13. The cascade (index of the season group, of the episode group; `E` = explicit: the name states both numbers), first usable hit wins: (1) `[Ss](\d{1,2})[Ee](\d{1,3})(?:[_\-Ee]+(\d{1,3}))*` season 1, episode 2, end 3, E (the repeated group keeps its LAST iteration: `S01E01-E03` end 3, `S01E01E02E04` end 4); (2) `[Ss](\d{1,2})\s*[Ee](\d{1,3})` 1/2 E; (3) `[Ss](\d{1,2})\s*[.\- _][Ee](\d{1,3})` 1/2 E; (4) `(\d{1,2})[xX](\d{2,3})` 1/2 E; (5) `(?:^|[\s.])(\d)(\d{2})(?:[\s.]|$)` 1/2 (`Title 103` is S1E03); (6) `(?:Part|Pt)\s*\.?\s*(\d{1,3})` case-insensitive, no season, episode 1; (7) `(?:Episode|Ep)\s*\.?\s*(\d{1,3})` case-insensitive, no season; (8) `(?:^|[\s.])- (\d{2,4})(?:[\s.]|$)` no season (anime ` - 03`); (9) `[Ee](\d{2,3})(?:[^a-zA-Z\d]|$)` no season. A pattern without a season group gives season 1. Regex semantics for rules 11-16 (`release.md` rule 7 applies): all are non-`u` JS patterns, so `\d` is `[0-9]` (Rust's Unicode `\d` would hand Arabic-Indic or fullwidth digits to `parse`, where JS never matches them), `\s` is `js::is_ws`, and the `i` patterns (11, 6, 7, `NUMBERED_SPECIAL`, `SPECIAL_TOKEN`, `SPECIALS_FOLDER`) must not fold U+212A or U+017F (`(?i)` in Rust matches `k`/`s` with them: use `(?i-u)` or ASCII classes); the lookaheads (`\.(?!\d{4})`, `(?![0-9])`) need `fancy_regex` or a manual check; every pattern is non-global, so no `lastIndex` state. A repeated group reports its last iteration.
14. Per hit, in this order: `episode = parseInt(group)`; an `E` pattern with `episode === 0` returns `None` (a `SxxE00` special states no number; no later pattern may guess); `episode < 1` continues to the next pattern; when the name is special (rule 15) and the pattern is not `E` returns `None`; `episodeEnd` is set only by pattern 1 and only when the end group matched and is greater than `episode` (else absent); no-season patterns return `{season: 1, episode, episodeEnd}`; otherwise `season = parseInt(season group)` and a negative season continues (impossible with these groups). No hit: `None`. A season-only pack (`S02`) is `None`.
15. Specials before the cascade: `NUMBERED_SPECIAL` = `(?:^|[^a-z0-9])(?:specials?|ova|oav|ovd|sp|ncop|nced)[ ._-]*(\d{1,2})(?![0-9])` (case-insensitive) on the RAW `sourceTitle`; when it matches and the number is at least 1 the answer is `{season: 0, episode}` at once (`Show - OVA - 01` is S00E01); a number 0 falls through. `special = is_special_file(filePath ?? sourceTitle)` (so a `Specials` folder in the full path counts only when the caller passes the path).
16. `is_special_file(pathOrName)` = any of: `SPECIALS_FOLDER` `(?:^|[\\/])(?:specials?|(?:season|saison)[ ._-]*0+)(?:[\\/])` (a `Specials` or `Season 00` folder, case-insensitive); `SPECIAL_TOKEN` `(?:^|[^a-z0-9])(?:specials?|ova|oav|ovd|ncop|nced)(?:[^a-z0-9]|$)` (no `sp`: too short); `NUMBERED_SPECIAL`; `DECIMAL_EPISODE` `(?:^|[^0-9])\d{1,3}\.5(?:[^0-9]|$)` (case-sensitive: `12.5`); `EPISODE_ZERO` `(?:[Ss](\d{1,2})[ ._-]*[Ee]|(\d{1,2})[xX])0+(?![0-9])` (`S01E00`, `1x00`).
17. `match_special_by_title(filename, specials)` (returns the index of the winning element): `haystack = normalize_title(basename(filename) minus its extension)`; for each special in order, `needle = normalize_title(title ?? '')`; skip a needle shorter than 4 characters (ASCII after rule 18, so byte length = JS length); skip when `haystack` does not contain it; the winner is the earliest position, ties on position go to the LONGER needle, and a still-tied later special does not replace the first; none -> `None` (no guessing). Callers pass the specials `ORDER BY "episodeNumber" ASC, id ASC`, so a full tie is deterministic.
18. `normalize_title(s)`: NFD, delete every `\p{Diacritic}` code point (this includes ASCII `^` and `` ` `` and U+00B7, which then do NOT become spaces), lower-case, replace each run of `[^a-z0-9]+` by one space, trim. Needs `unicode-normalization` (`release.md` rule 54).
19. `basename(filename)` minus `extname`: `path` semantics, POSIX flavour (`/` only; trailing separators ignored): `extname` = from the last `.` of the last segment to its end, `''` when the dot is the first character of the segment, absent, or the segment is `..`; `basename(p, ext)` removes `ext` only when the segment is longer than it and ends with it (`.mkv` alone keeps its name; `a.` has extname `.`). On a Windows host the win32 flavour applies (`\` also separates), selected by `cfg!(windows)`; the vectors are POSIX and the win32 cases are Rust unit tests. `extname` of `a.mkv`/`.mkv`/`a.`/`..`/`a..`/`a.mkv/` = `.mkv`/`''`/`.`/`''`/`.`/`.mkv`, basename minus it `a`/`.mkv`/`a`/`..`/`a.`/`a`. Every caller already passes a basename (`path.basename(absPath)`, `sourceBase`), so only the extension strip matters in practice.
20. Out of scope: quality parsing and season-number parsing: the quality of a file comes from `parse_release_quality` / `quality_from_resolution` (`release.md`).

### D. Consistency and safety

21. Default folder format: the media-write caller reads `naming_movie_folder_format` itself and falls back to `{Original Title} ({Release Year})` when the key is absent, while `get_formats` (disk import) falls back to `{Movie Title} ({Release Year})`; series folders agree (`{Series Title}`). So the same default install names a TMDB import after the ORIGINAL title and a disk import after the (localised) title. Both fallbacks are kept (the media-write caller passes its literal fallback; `load_formats` keeps the documented default).
22. The functions return a single path component (rule 7 removes both separators); they do not know the library root and never touch the disk. The caller joins and confines (`library-ingest`: `relativePathUnderMediaRoot`; ingest and importers specs).
23. `unicode-normalization` is a `fliks_domain` dependency (`release.md` rule 54); an empty `naming_movie_format` / `naming_series_format` yields a file named only by its extension (rejecting it belongs to the settings spec).

## SQL

One read: `SELECT key, value FROM app_settings WHERE key = ANY($1)` with the seven keys; `value` is nullable text. No write.

## Events

none.

## Settings keys

A format is keyed by `(kind, scope)`, `scope` being `file`, `folder` (the title's folder) or `group_folder` (the folder of one group of items, a season). `setting_key(kind, scope)` derives the key; a pair with no key (a movie or a book has no group) is `None`.

| Key | `(kind, scope)` | Default (when absent or NULL) | Parsing |
|---|---|---|---|
| `naming_movie_format` | movie, file | `{Movie Title} ({Release Year}) {Quality Full}` | raw text, any string |
| `naming_movie_folder_format` | movie, folder | `{Movie Title} ({Release Year})` (media-write fallback `{Original Title} ({Release Year})`, rule 21) | raw text |
| `naming_series_format` | series, file | `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}` | raw text |
| `naming_series_folder_format` | series, folder | `{Series Title}` | raw text |
| `naming_season_folder_format` | series, group_folder | `Season {season:00}` | raw text |
| `naming_book_format` | book, file | `{Title} ({Year})` | raw text |
| `naming_book_folder_format` | book, folder | `{Title}` (media-write fallback identical) | raw text |

Written by `PUT /api/settings` (`settings.md`), not validated (a format with no token, or an empty one, is accepted); read on demand by rule 3.

## Jobs/timers

none.

## Vectors/parity

Set `naming` (fixtures `server/fixtures/naming/cases.json`, replay `crates/domain/tests/naming.rs`). Case `fn` tags and outputs: `getFormats` (`rows` -> the seven-field object), `applyMovieFormat`, `applySeriesFormat`, `applyMovieFolderFormat`, `applySeriesFolderFormat`, `applySeasonFolderFormat`, `applyBookFormat` (`{format, data}` -> string), `extractReleaseGroup` (`title` -> string), `parseEpisodeNumbers` (`{title, filePath?}` -> object or null), `isSpecialFile` (`path` -> bool), `matchSpecialByTitle` (`{filename, specials}` -> the index of the returned element, or null). No `$` in generated values (rule 9).

Generated (seed `0x4a31`): format strings from the token vocabularies of rule 4 (valid tokens, wrong-case tokens, unknown `{Foo}`, a lone `{`, repeated tokens, empty string) mixed with literal text containing every character of rule 7 step 3, `(`, `)`, `[`, `]`, double spaces, `undefined`, accents, CJK; data values: empty, null/absent, `0`, `2023`, 3-digit and negative season/episode, titles containing tokens (`{Release Year}`), controls, trailing dots; 900 `apply*` cases. `getFormats`: all 32 present/absent combinations of the five keys with stored values `''`, `null`, text, 60 cases. `extractReleaseGroup` 120. `parseEpisodeNumbers` 700: every pattern of rule 13 x separators (`.`, `_`, space, `-`) x years (`.2023.` before and after) x special markers (`OVA 02`, `SP01`, `Special 3`, `NCED 1`, `Specials/`, `Season 00`, `12.5`, `S01E00`, `1x00`) x `filePath` present/absent. `isSpecialFile` 200, `matchSpecialByTitle` 150 (accents, case, punctuation, equal positions with different lengths, titles under 4 characters, empty and absent titles). The divergence characters of `release.md` rule 7 appear in every family.

Tests without a vector: `$` literals (rule 9); `.` and `..` movie/series folder results (rule 10); the win32 `basename`/`extname` cases (rule 19); a movie folder format `''` and a file format `''` (rule 3).

Parity: none (no route). The importers' and ingest scenarios exercise naming through the generated media at `/tmp/fliks-parity/`.

## Open questions

None.
