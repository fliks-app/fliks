# Spec: release (parsing and scoring)

Pure logic for `fliks_domain::release::{parsing,scoring}`: quality, attribute, language, season/episode and title parsing, release rejection and sorting, and the custom-format matcher. No route, no SQL, no event. HTTP consumers: `POST /api/custom-formats/test` (`profiles.md` rule 22) only; Rust callers are listed in the Routes table.

## Routes

none. Callers (who needs which function, and when):

| Function group | Rust caller |
|---|---|
| `parse_release_quality`, `rank_from_quality_string`, `app_quality_by_id` | media list/tracking, rescan, ingest, disk import, auto-grab |
| `quality_from_resolution` | rescan, library ingest |
| `extract_media_title`, `decode_html_entities` | disk import |
| `parse_release_attributes`, `parse_release_language`, `parse_season_episode`, `coverage_of` | custom-format matcher, subtitle scorer |
| `release::scoring::*` except the matcher | plugin host (`releases.score`) |
| `custom_format::*` | `POST /custom-formats/test` |

## Rules

### A. Layout, API and JS semantics

1. Layout (`crates/domain`, no IO, no async): `src/language.rs` (`APP_LANGUAGES`, next to `normalize_language_code`); `src/release/mod.rs` = `pub mod parsing; pub mod scoring;`; `release/parsing/{mod,quality,quality_from_resolution,attributes,language,season_episode,title}.rs`; `release/scoring/{mod,flags,sizes,titles,rejection,sort,pipeline,custom_format}.rs`; `src/profiles.rs` (`default_sizes`, `profiles.md` rule 26). Tests `crates/domain/tests/{release_parsing,release_scoring,custom_formats,naming}.rs` replay `server/fixtures/<set>/cases.json` with the helper `tests/common/mod.rs::replay(set, count, f)`; `BLESS=1` rewrites `expected`, never by hand.
2. Public API, `release::parsing` (`serde(rename_all = "camelCase")`; `Option` fields serialise as `null`):
   ```rust
   // quality.rs
   pub fn parse_release_quality(title: &str) -> ParsedReleaseQuality;       // {quality: AppQuality, label: String}
   pub fn rank_from_quality_string(q: Option<&str>) -> u32;
   pub fn app_quality_by_id(id: i64) -> Option<&'static AppQuality>;
   // quality_from_resolution.rs
   pub fn quality_from_resolution(source_text: &str, width: Option<f64>, height: Option<f64>) -> String;
   pub fn bucket_resolution_height(width: Option<f64>, height: Option<f64>) -> u32;
   // attributes.rs
   pub fn parse_release_attributes(title: &str) -> ReleaseAttributes;       // {resolution: u32, source, videoCodec, audioCodec, edition, releaseGroup: Option<String>, hearingImpaired: bool}
   // language.rs
   pub fn parse_release_language(title: &str) -> &'static AppLanguage;
   pub fn resolve_unknown_language(parsed: &'static AppLanguage, unknown_iso: Option<&str>) -> &'static AppLanguage;
   // season_episode.rs
   pub fn parse_season_episode(title: &str) -> ParsedSeasonEpisode;         // {season, episode, isFullSeason, seasonEnd, episodeEnd, isCompleteSeries}
   pub fn coverage_of(p: &ParsedSeasonEpisode) -> ReleaseCoverage;          // {seasons: Option<Span>, episodes: Option<Span>, completeSeries}
   pub fn release_coverage(title: &str) -> ReleaseCoverage;
   pub fn within(range: &Span, n: i64) -> bool;                             // inclusive
   // title.rs
   pub fn extract_media_title(raw_name: &str) -> ExtractedRelease;          // {searchKey, title, year, season, episode, isFullSeason, kind: "series"|"movie"|"unknown"}
   pub fn decode_html_entities(s: &str) -> String;
   ```
3. Public API, `release::scoring` (`BTreeSet`/`Vec` for sets and maps; fixtures carry them as sorted arrays and `[key, value]` pair lists):
   ```rust
   pub fn release_flags(flags: &[String], freeleech: Option<bool>, download_volume_factor: Option<f64>) -> Vec<String>;
   pub fn max_resolution_from_quality_strings(files: &[Option<&str>]) -> u32;
   pub fn allowed_audio_language_ids(items: &[AudioLanguageItem]) -> BTreeSet<u32>;
   pub fn build_allowed_quality_ids(items: &[QualityProfileItem]) -> BTreeSet<u32>;
   pub fn detect_video_codec(title: Option<&str>) -> Option<&'static str>;   // "AV1" | "HEVC" | "VP9" | "x264"
   pub fn detect_codec_size_factor(title: Option<&str>) -> f64;
   pub fn compute_size_deviation(title: &str, size_bytes: f64, runtime_minutes: f64, limits: Option<&SizeLimits>) -> Option<f64>;
   pub fn resolve_search_titles(media: &SearchMedia, custom_query: Option<&str>) -> SearchTitles;   // {searchTitle, expectedTitles}
   pub fn index_title_expectations(expected: &[String]) -> TitleExpectationIndex;
   pub fn release_title_tokens(title: &str) -> BTreeSet<String>;
   pub fn matches_indexed_expectation(tokens: &BTreeSet<String>, index: &TitleExpectationIndex, when_unreadable: WhenUnreadable) -> bool;
   pub fn appended_sequel_number(release_title: &str, index: &TitleExpectationIndex) -> Option<String>;
   pub fn collection_pack_word(release_title: &str, index: &TitleExpectationIndex) -> Option<String>;
   pub fn release_years(title: &str) -> Vec<u32>;
   pub fn compute_rejections(o: &RejectionInput) -> Vec<ReleaseRejection>;      // {code: String, params?: {k: number|string}}
   pub fn sort_releases_by_relevance<T: Sortable>(rows: Vec<T>, prefer_full_season: bool) -> Vec<T>;
   pub fn score_and_sort_releases(releases: Vec<ReleaseCandidate>, opts: &ScoreOptions, score_custom_formats: &dyn Fn(&str, &[String]) -> i64, is_blocked: &dyn Fn(&str, i64) -> bool) -> Vec<ScoredRelease>;
   // custom_format.rs
   pub fn matches_format(title: &str, fmt: &CustomFormat, flags: &[String]) -> bool;
   pub fn score_release_with(formats: &[CustomFormat], title: &str, flags: &[String]) -> i64;
   pub fn test_release(formats: &[CustomFormat], title: &str, flags: &[String]) -> Vec<CustomFormatMatch>;  // {formatId, formatName, matched, score}
   pub fn validate_title_regexes(specs: &[CustomFormatSpec]) -> Result<(), String>;   // Err(value) of the first bad title_regex
   ```
   The two lookups are synchronous closures over tables the caller precomputed. `expectedTitle: string | string[]` is an untagged enum on the wire; an empty string means absent in `compute_rejections` (rule 38), `[]` does not.
4. `APP_LANGUAGES`: 38 rows, ids 1..37 then 99, (`id`, `name`, `isoCode`, `iso639_2` list, absent on id 99 `Unknown`/`xx`). `UNKNOWN_LANGUAGE` = id 99, `ENGLISH_LANGUAGE` = id 1; lookups by id and by `isoCode`; a missing `isoCode` lookup falls back to `UNKNOWN_LANGUAGE` in the parser (`lang(code)`). Serialises to the `GET /api/profiles/language-definitions` body (`profiles.md` rule 16). Golden fixture `app-languages` (one case, the whole table).
5. JSON conventions of fixtures and wire: an undefined value is an absent key, a null value is `null`; numbers via serde_json with `float_roundtrip` (already enabled in `fliks_domain`); `Math.round` = `js::round` (half toward +infinity, `crates/domain/src/js.rs`); `parseInt(x, 10)` of a digit run = decimal parse of the leading digits (`NaN` = failure).
6. Three different normalisations exist and are not interchangeable: quality/attributes `norm` = replace every `.` with a space then lower-case; language `norm` = replace each of `.`, `_`, `-` with a space then lower-case; custom-format `norm` = drop every char outside `[a-z0-9]` (case-insensitively) then lower-case; the `i` flag has no `u`, so no non-ASCII char survives (U+017F, U+212A are dropped): Rust keeps `char::is_ascii_alphanumeric`, never a Unicode `(?i)` class. Nothing else is normalised: the season/episode parser, `extractMediaTitle` and the title tokenizer read their own inputs (rules 19, 24, 31).
7. Regex semantics (as in `parse_release_quality`: `\b` -> `(?-u:\b)`): every fixed pattern is a JS-flavoured pattern without the `u` flag, so `\b`, `\d`, `\w` are ASCII, `\s` is the JS whitespace set (`js::is_ws`: Unicode White_Space minus U+0085 plus U+FEFF), `.` excludes line terminators, `i` folds with `toUpperCase` (U+212A KELVIN SIGN does not match `k`; Rust's Unicode `(?i)` does). Each pattern uses the Rust form that satisfies the vectors; fixed patterns that use lookahead/lookbehind (`SEASON_X_EPISODE_RE`, `SEASON_DASH_EPISODE_RE`, `SEASON_ONLY_RE`, `NUMBERED_SPECIAL`, `EPISODE_ZERO`, the `\.(?!\d{4})` split of `naming.md`) use `fancy_regex`. The generated corpora MUST contain, for every regex family, the divergence characters: U+212A, U+017F (long s), `İ`, `Σ`/`ς`, Arabic-Indic and fullwidth digits, U+00A0, U+FEFF, U+0085, U+2028, accented letters adjacent to keywords (`Éfrench`, `frenchÉ`). No pattern of these files relies on `lastIndex` (the only `g` patterns go through `matchAll`/`replace`). The vectors decide.
8. Case and Unicode: Lower-casing is Rust `str::to_lowercase` on the vector corpus (Final_Sigma applies; `İ` -> `i̇`); `normalize('NFD')`, `normalize('NFKC')` need `unicode-normalization` (rule 54); `\p{L}`, `\p{N}` and naming's `\p{Diacritic}` are `regex` classes (`regex-syntax` 0.8 has `Diacritic`). Unicode table versions can differ on new code points: the vectors decide.
9. The title match used by `releases.match` is the composition `index_title_expectations` + `release_title_tokens` + `matches_indexed_expectation`; matching a release against a media is `resolve_search_titles` followed by that composition. There is no separate function for either.

### B. Quality

10. `APP_QUALITIES` (24 rows), `app_quality_by_id`, `parse_release_quality`, `rank_from_quality_string` (`None` and `""` rank 0; `parse_release_quality("")` is `Bluray-480p`). A 4320p/8K title yields quality = WORKPRINT id 1 with label `4320p (HDTV-2160p)` (the first `APP_QUALITIES` row). Behaviour: `media-query.md` rules 37, 44, 69.
11. `rank_from_quality_string` is the quality column's rank everywhere (`cutoffUnmet`, auto-grab, acquisition candidates, plugin host); `app_quality_by_id` is called with a profile's `cutoff` (may be unknown: `None`).
12. `quality_from_resolution(sourceText, w, h)` (used by rescan and ingest to name a file by its real pixels): `bucket = bucket_resolution_height(w, h)`, `resolution = bucket >= 2160 ? 2160 : bucket <= 480 ? 480 : bucket` (so 144/240/360 become 480; 720 and 1080 stay); source from `sourceText` with every `.` replaced by a space, lower-cased: default `hdtv`, then the first test that matches in this order: `\bremux\b` -> remux, `\b(bluray|blu-?ray|bdrip|brrip)\b` -> bluray (no `bdr`, unlike the parsers), `\bweb-?dl\b` -> web, `\bweb-?rip\b` -> web, `\b(dvd|dvdrip)\b` -> dvd (no `dvd-?r`; no sdtv). Result = name of the first `APP_QUALITIES` row with that resolution AND source; else the first row with that resolution; else `HDTV-<resolution>p`. Examples: `web` + 480 gives `WEBDL-480p` (first of two); `dvd` + 720 has no row and returns `HDTV-720p`; the default `hdtv` at 480 has no row either and returns the first 480 row, `DVD`.
13. `bucket_resolution_height(w, h)` (`w`, `h` default 0): both 0 -> 480; then first match of: `w <= 256 && h <= 192` 144; `w <= 426 && h <= 320` 240; `w <= 640 && h <= 432` 360; `w <= 854 && h <= 576` 480; `w <= 1280 && h <= 962` 720; `w <= 1920 && h <= 1440` 1080; else 2160.

### C. Attributes

14. `parse_release_attributes(title)`: `t = norm(title)` (rule 6) feeds every detector except `releaseGroup`, which reads the RAW title. Detectors return the FIRST matching branch in listed order: resolution (4320 for `4320p?|8k`, 2160 for `2160p?|4k|uhd`, `1080[ip]?`, `720[ip]?`, then `(576|480|360)p?` giving that number, else 0); source (`remux`, `bluray` incl. `bdr`, `web-dl`, `webrip`, `hdtv`, `dvd` incl. `dvd-?r`, `sdtv`, `cam`, `ts` incl. `telesync`, `tc` incl. `telecine` with NO `\b` (`\btc\b|telecine`: `telecined` matches), else null; note `web-dl` is tested before `webrip`, and `cam`/`ts`/`tc` after the sources, the reverse of `parseReleaseQuality`); video codec (`h265`, `h264`, `av1`, `vp9`, `xvid`, `mpeg2`; `h\.?265` can never see a dot because `norm` removed it, so `h.265` is read as `h 265` and matches nothing: pinned); audio codec (`truehd`, `dts-hd`, `dts`, `eac3` incl. `ddp`, `ac3` incl. `dd5`, `flac`, `aac`, `opus`, `mp3`); edition (`directors-cut` incl. a bare `dc`, `extended`, `theatrical`, `uncut`, `remastered`, `criterion`, `imax`).
15. `releaseGroup`: strip a trailing extension `\.[a-z0-9]{2,4}$` (case-insensitive) from the raw title, then take `-([a-z0-9_]+)$` (case-insensitive) and lower-case it; null when no match or when the group is one of `1080p 720p 2160p 480p hevc x264 x265 av1 h264 h265 dvd web bluray remux` (exact, after lower-casing). A trailing `-DL` of `WEB-DL` is a group `dl`, and a title ending `.x264` loses it as an "extension" first.
16. `hearingImpaired` = `\b(sdh|hi|hearing[\s\-_]?impaired|cc|closed[\s\-_]?caption)\b` on `t`: any release with a standalone `hi` or `cc` token reads as HI (frozen). The field is read only by the subtitle scorer (S6); custom formats ignore it.

### D. Language

17. `parse_release_language(title)`: `t = norm_lang(title)` (rule 6), then the first matching family in this order returns `lang(code)`: fr, de, es, it, pt, ja, ko, zh, ru, ar, nl, pl, tr, sv, da, no, fi; then `\bmulti\b` -> `UNKNOWN_LANGUAGE`; else `ENGLISH_LANGUAGE`. Keywords include short words that collide with English (`no`, `pl`, `nl`, `sv`, `dk`, `chi`, `por`, `dan`, `fin`, `kor`, `tur`, `esp`, `spa`, `ita`, `rus`, `ara`, `swe`, `nor`): `No.Country.for.Old.Men.2007` is Norwegian. Frozen; the corpus pins every keyword. Non-ASCII letters sit inside classes (`portugu[eê]s`, `japon[ae]s`, `cor[eé]en`, `su[eè]dois`, `norv[eé]gien`) and `\b` is ASCII, so an accented neighbour counts as a boundary (rule 7).
18. `resolve_unknown_language(parsed, unknown_iso)`: when `parsed.id != 99` or `unknown_iso` is absent/empty, return `parsed`; else the `APP_LANGUAGES` row with that `isoCode`, else `parsed` (still Unknown).

### E. Season and episode

19. Patterns (rule 7 for the regex flavour): `SE_RE`, `SEASON_RANGE_RE`, `SEASON_WORD_RANGE_RE`, `SEASON_LIST_RE`, `SEASON_DASH_EPISODE_RE`, `SEASON_ONLY_RE`, `SEASON_KEYWORD_RE`, `SEASON_X_EPISODE_RE` (lookbehind `(?<![a-zA-Z\d])`, lookahead `(?!26[45]\b)`), `COMPLETE_SERIES_RE`. All are case-insensitive and applied to the raw title (no normalisation).
20. `parse_season_episode(title)` tries, first hit wins: (1) `SE_RE` -> season, episode, `isFullSeason false`, `episodeEnd` = last number of the chained `-?E\d+` tail or of the `-NN` tail, kept only when greater than `episode` (`upTo`); (2) `SEASON_X_EPISODE_RE` (same episode-end rule); (3) `SEASON_RANGE_RE` then `SEASON_WORD_RANGE_RE` -> pack with `seasonEnd` only when greater than `season` (else the range is rejected and the search goes on); then `SEASON_LIST_RE` -> pack only when the listed numbers are strictly consecutive (`S01.S03` and `S04-S02` are single seasons); (4) `SEASON_DASH_EPISODE_RE` (`S2 - 04`; `(?![.,]\d)` keeps `S01 - 5.1` out); (5) `SEASON_ONLY_RE` (`S01` not followed by `E\d`) -> pack; (6) `SEASON_KEYWORD_RE` -> pack; else all null. `isCompleteSeries` = `season === null && COMPLETE_SERIES_RE.test(title)`, computed on every result. Episode 0 is a legal episode here (unlike naming rule 14).
21. `coverage_of(p)`: `seasons = season === null ? null : {from: season, to: seasonEnd ?? season}`; `episodes = episode === null ? null : {from: episode, to: episodeEnd ?? episode}`; `completeSeries = isCompleteSeries`. `release_coverage(title)` composes both. `within(range, n)` is inclusive on both ends. Used by `compute_rejections` (rules 40, 43).

### F. Title extractor

22. `decode_html_entities(s)`: replace each `&(?:#(x?)([0-9a-fA-F]+)|([a-zA-Z]+));` : numeric: `parseInt(digits, hex ? 16 : 10)`; a decimal reference whose digit run contains `a-f` parses only its leading decimal digits (`&#12ab;` -> code 12; `&#ab;` -> NaN -> raw); a code that is not finite, is `<= 0`, or is above 0x10FFFF stays raw; named: the table of 102 entities (`amp lt gt apos quot nbsp` and the Latin-1/Latin Extended set, `ldquo`...`euro`), case-sensitive, unknown name stays raw; `&nbsp;` decodes to a plain U+0020 space, NOT U+00A0 (pinned). Code points 0xD800-0xDFFF decode to U+FFFD, since a Rust `String` cannot hold a lone surrogate (only a file name with a literal `&#55296;` reaches it): covered by a Rust unit test, not by the vectors (serde_json cannot carry a lone surrogate).
23. `extract_media_title(rawName)`: (a) decode entities, strip a trailing `.torrent` (case-insensitive), then strip the last `.ext` when that last `.` is not at index 0 and the lower-cased extension is in `VIDEO_EXTS` (`.mkv .mp4 .avi .mov .ts .m2ts .wmv .flv .webm .m4v .mpg .mpeg .ogm .mts`, shared with the ingest spec); (b) `se = parse_season_episode(decoded)`; (c) years = every `\b((?:19|20)\d{2})\b` of the full string; `SE_CUT_RE` is searched on the string and its FIRST match index is the cut (the first match, not the last); years before the cut when there is a cut, else all years; `year` = the first of them or null; (d) title slot: before the cut; else before the first `\b<year>\b`; else before the first `METADATA_CUT_RE` token; else the whole string; (e) `prettify`: `[._]+` -> space, strip a trailing `\s*\(?\b(19|20)\d{2}\)?\s*$`, `()[]{}` -> space, collapse whitespace, strip leading/trailing `[\s\-:]`, trim; `searchKey` = lower-cased title with `[^a-z0-9]+` removed; `kind` = `series` when `se.season !== null`, else `movie` when `year !== null` and there is no cut, else `unknown`. `season`, `episode`, `isFullSeason` come from `se`. Quirks pinned: `1917.2019.1080p` reads year 1917 and an empty title; a title that contains a cut-like token (`S1`, `Season 2`) before the real marker is cut early.

### G. Scoring

24. `release_flags(flags, freeleech, downloadVolumeFactor)`: the set of `flags` (insertion order kept, duplicates dropped) plus `freeleech` when `freeleech` is true or the factor is exactly 0, plus `halfleech` when the factor is exactly 0.5.
25. `max_resolution_from_quality_strings(files)`: max over `parse_release_quality(f.quality ?? '').quality.resolution`, 0 for none.
26. `allowed_audio_language_ids(items)`: empty or absent -> empty set (= no restriction); else the `APP_LANGUAGES` ids whose `isoCode` equals an item's `isoCode` (unknown codes are skipped, so a profile of only unknown codes is also empty = unrestricted).
27. `build_allowed_quality_ids(items)`: empty -> empty (= nothing allowed); ids of `allowed` items, plus every item whose non-null `groupId` equals the `groupId` of an allowed item (one allowed member allows the whole group).
28. Codec: `detect_video_codec(title)` on the lower-cased title, first hit: `\bav1\b` AV1, `\b(x265|h[.\s-]?265|hevc)\b` HEVC, `\bvp9\b` VP9, `\b(x264|h[.\s-]?264|avc)\b` x264, else null (null/empty title null). `detect_codec_size_factor`: AV1 0.45, HEVC 0.55, VP9 0.6, anything else 1. Unlike the attribute parser this one sees dots.
29. `compute_size_deviation(title, sizeBytes, runtimeMinutes, limits)`: null when `limits` is absent or `limits.preferred <= 0`, or `runtimeMinutes <= 0`, or `sizeBytes <= 0`; `mbPerHour = (sizeBytes/1048576) / (runtimeMinutes/60)`; `preferred = limits.preferred * codecFactor`; null when `preferred <= 0`; result `abs(mbPerHour - preferred) / preferred`.
30. Title tokenizer: `fold_case(s)` = NFD, delete code points U+0300-U+036F, lower-case; `tokenize` = replace `[^a-z0-9]+` by space, trim, split on space, drop empties (so non-ASCII letters such as `ß` or `ø` act as separators); `titleReadings(t)` = two readings of the folded title: apostrophes `'`, `‘`, `’`, `ʼ` removed then tokenized, and tokenized with the apostrophe left to split; `significant_tokens(tokens)` drops tokens of length 1 and the 27 stop words (`a au aux de des du la le les l un une et ou en d s the an of and or in on at to for`) and falls back to all tokens when that empties the list; `fold_title(s)` = NFKC, lower-case, keep only `\p{L}\p{N}`.
31. `index_title_expectations(expected)`: candidates = non-empty after trim; none -> `{readings: [], numbers: {}, vacuous: true, folded: []}`; else for each candidate and each of its two readings: every all-digit token of the FULL reading joins `numbers` (single digits included), `significant_tokens` non-empty joins `readings`; `folded` = `fold_title` of each candidate, empty results dropped. `release_title_tokens(t)` = the set of all tokens of both readings of the release title (no stop-word filter).
32. `matches_indexed_expectation(tokens, index, whenUnreadable)`: vacuous -> true; true when every token of some reading is in `tokens`; else `readings` empty AND `whenUnreadable == 'match'` (default).
33. `appended_sequel_number(releaseTitle, index)`: null when vacuous or no readings. For each reading of the release title and each expected reading, find the expected tokens in order (gaps allowed, `indexOf` from the previous hit) -> next token after the last one; if any pair that carries the whole expectation has no next token, a next token that is not a sequel number (`^([2-9]|[1-9]\d|ii|iii|iv|vi|vii|viii|ix)$`), one already among the expected tokens, or one in `index.numbers`, the answer is null at once; otherwise the first such next token found. Pairs that do not carry the expectation are skipped.
34. `collection_pack_word(releaseTitle, index)`: the first token (reading order, both readings flattened) matching `^(collection|collections|duology|trilogy|quadrilogy|tetralogy|pentalogy|hexalogy|anthology|saga|filmography)$` that is not among the tokens of `index.readings`, else null.
35. `release_years(title)`: every `\b(?:19|20)\d{2}\b` match of the RAW title as a number (ASCII `\b`, so `1080p`, `x264`, `DDP5.1` give none).
36. `resolve_search_titles(media, customQuery)`: a non-blank `customQuery` (trimmed) is both `searchTitle` and the single expected title; else `expectedTitles` = `[originalTitle, title, ...alternativeTitles]` without null/empty; `searchTitle` = the first expected title whose index has at least one reading, else `originalTitle || title`.
37. `compute_rejections(o)` returns the rejections in this fixed emission order, each `{code, params?}` (`params` key absent when none): title block (rule 38), `YEAR_MISMATCH`, `EPISODE_MISMATCH`, `FULL_SEASON_FOR_EPISODE`, `QUALITY_NOT_ALLOWED`, `CUSTOM_FORMAT_SCORE_TOO_LOW`, `RANK_NOT_AN_UPGRADE`, `RANK_ABOVE_CUTOFF`, `RESOLUTION_NOT_UPGRADED`, `LANGUAGE_NOT_ALLOWED`, `BLOCKLISTED`, `SIZE_TOO_LOW`, `SIZE_TOO_HIGH`, `MIN_SEEDERS`. Codes are the contract with the client's i18n (`code` byte for byte).
38. Title block (only when `expectedTitle` is truthy and `releaseTitle` is non-empty; the string `""` is falsy but the array `[]` is truthy): `index = index_title_expectations(expectedTitle)`; `matches` = `matches_indexed_expectation(tokens)` when the index has readings, else `index.folded.some(f => fold_title(releaseTitle).includes(f))`. Not matching -> `TITLE_MISMATCH` and nothing else of the block. Matching -> `SEQUEL_MISMATCH {number}` when `appended_sequel_number` is non-null, then `COLLECTION_PACK {word}` when `expectedSeason` is absent or `expectedEpisode` is present AND `collection_pack_word` is non-null. Quirk pinned: `expectedTitle: []` is vacuous (no readings, no folded) so it falls to the folded test, which is false: every release gets `TITLE_MISMATCH`, while `matches_indexed_expectation` alone would say true.
39. Year: when `releaseTitle` and a truthy `expectedYear`: `years = release_years`; when non-empty and no year is within 1 of `expectedYear` -> `YEAR_MISMATCH {expected: <number>, actual: "<years joined by ', '>"}` (string).
40. Episode targeting (when `releaseTitle` and (`expectedSeason` or `expectedEpisode` is set)): `cov = o.coverage ?? release_coverage(title)`; `wrongSeason` = season expected and `cov.seasons` known and `!within`; `wrongEpisode` likewise with episodes (a null side never rejects) -> `EPISODE_MISMATCH {expected, actual}` with `expected = formatSeasonEpisode(expectedSeason, expectedEpisode)` and `actual = formatCoverage(cov)` (`S04E03`, `S04`, `E03`, `?`; ranges `S01-S03`, `S01E04-E05`; two digits zero-padded, no truncation). Then, when `expectedEpisode` is set and (`cov.seasons` known with `cov.episodes` null, or `cov.completeSeries`) -> `FULL_SEASON_FOR_EPISODE {expected}`.
41. Quality, score, rank, resolution, language, blocklist: `QUALITY_NOT_ALLOWED` when `qualityId` is not in `allowed` (empty allowed set rejects everything); `CUSTOM_FORMAT_SCORE_TOO_LOW {actual, min}` when `minCustomFormatScore` is set and `(customFormatScore ?? 0) < min`; with `rank` set: `RANK_NOT_AN_UPGRADE {actual, min}` when `minRankExclusive` is set and `rank <= min`, `RANK_ABOVE_CUTOFF {actual, max}` when `maxRankInclusive` is set and `rank > max`; `RESOLUTION_NOT_UPGRADED {actual, min}` when `minResolution > 0` and the release's parsed resolution (`parse_release_quality(title ?? '')`) is `<= minResolution`; `LANGUAGE_NOT_ALLOWED` when `allowedLangs` is non-empty and lacks `languageId`; `BLOCKLISTED` when `isBlocklisted`.
42. Size and seeders: `codecFactor = detect_codec_size_factor(title)`; `mbPerHour = size/1048576 / (runtime/60)` when both are positive else 0; `limits = sizeByQuality[qualityId] * codecFactor` (min, preferred, max); when limits exist and `mbPerHour > 0`: `SIZE_TOO_LOW {actual: round(mbPerHour), min: round(limits.min)}` when `limits.min > 0 && mbPerHour < limits.min`, then `SIZE_TOO_HIGH {actual, max}` when `limits.max > 0 && mbPerHour > limits.max` (`round` = `js::round`); `MIN_SEEDERS {actual: seeders, min}` when `sourceMinSeeders[sourceId] ?? 0 > 0` and `seeders < min`. `preferred` never rejects.
43. `sort_releases_by_relevance(rows, preferFullSeason)`, comparator in this order (first non-zero decides; `rejections` clean = empty): (1) clean before rejected; (2) not blocklisted first; (3) `languageAllowed` first; (4) `seeders > 0` before dead; (5) only with `preferFullSeason`: when both rows' quality resolutions are equal (`resolution` of `getAppQualityById(qualityId)`, 0 if unknown): a full-season row before a non-pack row; for two pack rows with known `coverage.seasons`, the narrower span first (`gap = spanA - spanB`, returned as is); (6) higher `rank`; (7) higher `customFormatScore`; (8) `flags` containing `freeleech` first; (9) swarm: `log2(max(n,0)+1)` of seeders, higher first only when the two differ by more than 0.25; (10) the same for leechers; (11) smaller `sizeDeviation` first, only when both are non-null and differ by more than 0.05; else 0 (stable).
44. Sort implementation. The comparator is not a total order: the epsilons of steps 9-11 of rule 43 (`seeders` 10, 12, 14 compare equal pairwise-adjacent but 10 < 14), and step 5 (equal resolutions only) once `rank` is not its `qualityId`'s own rank, as in generated rows (`qualityId: 16, rank: 100`): pack q16 rank 55 < loose q16 rank 68 < loose q11 rank 60 < the pack, a cycle (`score_and_sort_releases` always pairs them, and real ranks rise with resolution). Rust `slice::sort_by` may panic on such a comparator (Rust >= 1.81), so the sort is a stable merge or insertion sort that never panics. Two stable sorts agree whenever the comparator is a consistent total preorder, so exactness is guaranteed exactly there: a generated set that is not one is recorded with `"order": "unspecified"` and the replay asserts only that the output is a permutation and respects steps 1-4. Value grid for the exact sets: `seeders`/`leechers` with `log2(n+1)` gaps of 0 or above 0.25 (0, 1, 5, 20, 100, 500), `sizeDeviation` gaps of 0 or above 0.05 (rule 53).
45. `score_and_sort_releases(releases, opts, deps)`: per release (all independent): `parsed = parse_release_quality(title)`; `lang = resolve_unknown_language(parse_release_language(title), sourceUnknownLang[sourceId])`; `cfScore = deps.score_custom_formats(title, flags)`; `isBlocklisted = deps.is_blocked(title, sourceId)`; `coverage = release_coverage(title)`; `rejections = compute_rejections({..., coverage, rank: parsed.quality.rank, ...opts})`; output = the candidate's own fields plus `qualityId`, `qualityName`, `rank`, `allowed` (id in `opts.allowed`), `customFormatScore`, `blocklisted`, `languageId`, `languageName`, `languageAllowed` (`allowedLangs` empty or has it), `rejections`, `isFullSeason` (`coverage.seasons !== null && coverage.episodes === null`), `coverage`, `sizeDeviation` (rule 29 with `sizeByQuality[parsed.quality.id]`), `videoCodec` (rule 28). Then `sort_releases_by_relevance` with `preferFullSeason = expectedSeason != null && expectedEpisode == null`.

### H. Custom-format matching (`custom_format.rs`)

46. `matches_format(title, fmt, flags)`: a format with no specs matches nothing. Specs are grouped by `type`; conditions of one type are alternatives (OR), different types must all hold (AND); per spec `result = negate ? !raw : raw`; a `required` spec must hold on its own, whatever else its group does (a required failure fails the whole format). Result = every group has at least one true condition and no required condition is false (the loop's early returns do not change the value). `attrs = parse_release_attributes(title)` once per call.
47. Per type, `value` = custom-format `norm` of `spec.value` (rule 6): `title_regex` tests `RegExp(spec.value, 'i')` on the UNTOUCHED title, a pattern that does not compile is `false` (so a `negate` on it is TRUE: pinned); `source`: `norm(attrs.source) === value` (`web-dl` -> `webdl`); `resolution`: `attrs.resolution > 0 && attrs.resolution === parseInt(value, 10)` (`1080p` ok, `4k` reads 4 and never matches, `p1080` NaN); `language`: `parse_release_language(title)` and `norm(isoCode) === value || norm(name) === value || iso639_2.some(norm == value)` (an untagged release IS English, so `language:en` matches every untagged title); `release_flag`: any flag with `norm(flag) === value`; `release_group`, `edition`, `video_codec`, `audio_codec`: `norm(attrs.<field>) === value` (null attribute normalises to `""` and equals only an empty value, which the DTO forbids); an unknown `type` (only possible in stored data) is false.
48. `score_release_with(formats, title, flags)` = sum of `score` of the matching formats (`i64`); `test_release` = per format in input order `{formatId, formatName, matched, score: matched ? score : 0}`.
49. `validate_title_regexes(specs)`: for each `title_regex` in order, the value must compile (`profiles.md` rule 21); `Err(value)` of the first that does not. The engine is `regress` (`profiles.md` rule 39); `matches_format` and `validate_title_regexes` use the same one.

### I. Decisions

50. `title_regex` evaluation is unbounded: `regress` 0.12 has no backtracking budget and no step-budget row ships (`profiles.md` rule 39). Only an admin can write a pattern; a Rust unit test with `(a+)+$` against 40 `a` plus `!` documents the behaviour and is not run in CI.
51. All of `release::scoring` (rules 24-45) is implemented with its vectors even though its only caller is the plugin host.
52. Regex engine: `regress` with `icase` for `title_regex` (the meaning of stored patterns is kept; modifiers and full Annex B are probed before adopting), `regex` / `fancy-regex` for the fixed patterns of rule 7, settled by the vectors; no step budget (rule 50).
53. Sort exactness (rule 44): exact only when the comparator is a total order; the sort never panics, and for intransitive cases the order is unspecified.
54. `unicode-normalization` (NFD/NFKC) is a `fliks_domain` dependency; `\p{Diacritic}` comes from `regex`. Needed by rule 30 and naming rule 18; no alternative keeps `fold_case` identical on accented input.
55. Frozen quirks: `SE_CUT_RE` first match (rule 23), `expectedTitle: []` always `TITLE_MISMATCH` (rule 38), short-word language false positives (rule 17), `hi`/`cc` as hearing-impaired (rule 16), `h.265` unseen by the attribute parser (rule 14), 8K quality = WORKPRINT with a corrected label (rule 10).
56. `regress` is checked on 2200 `title_regex` cases (lookaround, backreferences, named groups, invalid patterns, Annex B escapes) against the JS flavour: identical except two corners, accepted as differences from the JS flavour and left out of the `custom-formats` vectors: `i` folds U+017F and U+212A with `s`/`k` (also in `\w` and `[a-z]`), as the `u` flag does, where JS without `u` does not; and `\u{41}` reads as a code point where JS reads a quantified `u`.

## SQL

none (pure). The matcher and scorer receive rows already read by their callers (`profiles.md` SQL).

## Events

none.

## Settings keys

none.

## Jobs/timers

none.

## Vectors/parity

Fixtures `server/fixtures/<set>/cases.json`, replayed in `crates/domain/tests/` (`release_quality.rs`, `release_parsing.rs`, `release_scoring.rs`, `custom_formats.rs`). Sets are JSON-roundtripped: a set is a sorted array, a map a list of `[key, value]` pairs; the replay rebuilds them.

- `release-quality` (746 cases), `app-qualities` (1), `app-languages` (1: the table).
- `release-parsing` (3435): `fn` tags `parseSeasonEpisode`, `releaseCoverage`, `within`, `parseReleaseAttributes`, `parseReleaseLanguage`, `resolveUnknownLanguage`, `extractMediaTitle`, `decodeHtmlEntities`, `qualityFromResolution`, `bucketResolutionHeight`. Generated families: the season/episode grammar (title words x every one of the nine pattern forms x separators `.`/` `/`_`/`-` x noise tokens x case x the rule 7 divergence characters), every alternative of every attribute detector alone and inside noise, every language keyword of rule 17 at each boundary, `resolveUnknownLanguage` over 38 languages x {known, unknown, absent} codes, movie/series/anime names for `extractMediaTitle`, every table entity plus numeric edge cases for `decodeHtmlEntities` (no surrogates), and a width x height grid on every ceiling of rule 13.
- `release-scoring` (3029): `fn` tags `computeRejections`, `sortReleasesByRelevance` (output = ids in order), `scoreAndSortReleases` (dependencies given as `customFormatScores: {title: n}` and `blocked: [[title, sourceId]]`), the title functions (`indexTitleExpectations`, `titleMatchesExpectation`, `releaseTitleTokens`, `appendedSequelNumber`, `collectionPackWord`, `releaseYears`, `resolveSearchTitles`, `releaseMatchesMedia`) and the helpers (`computeSizeDeviation`, `detectCodecSizeFactor`, `detectVideoCodec`, `buildAllowedQualityIds`, `allowedAudioLanguageIds`, `releaseFlags`, `maxResolutionFromQualityStrings`). `titleMatchesExpectation` cases run with both `whenUnreadable` values (`releases.match` passes `'no-match'`). Sort sets use the rule 44 value grid with and without `preferFullSeason`, plus `"order": "unspecified"` intransitive sets; every rejection code appears in at least 20 `computeRejections` cases, plus `expectedTitle: []` and `""`.
- `custom-formats` (2227): inputs `{formats, title, flags}`; formats of 1-4 specs drawn from the nine types with `negate`/`required`, values spelled with dots, dashes and case, a regex pool including invalid patterns and lookaround, titles from the release corpus; replay of `test_release` and `score_release_with`.
- `quality-definition-defaults`: `profiles.md` Vectors.

Parity: no route of its own; the matcher is covered by `custom-formats-test` (`profiles.md`).

## Open questions (user decisions)

None.
