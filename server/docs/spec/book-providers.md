# Spec: book metadata providers (pure layer)

Scope: the URL builders and the response parsers of the five free, keyless book providers, in `fliks_domain::book_providers`. Out of scope, built in 0.11: the HTTP clients, the token-bucket limiter, the `MetadataProvider` trait, the orchestrator (field merge, cache, circuit breaker, `metadata_snapshots`). Every function here is pure: a builder returns a URL string, a parser takes a response body and returns a `BookRecord` (or a page, or an error). The plan is `plans/books-audiobooks.plan.md` section 3.4, phase 1.2. Golden vectors: `fixtures/books-providers/<provider>/cases.json` plus the raw bodies beside it, replayed by `crates/domain/tests/book_providers.rs` (`BLESS=1` rewrites `expected`). Every title, name, ISBN, ASIN and id in the fixtures is invented; the shapes (fields, types, nesting, nulls, odd cases) come from live responses and the providers' documentation.

## Common model

1. `BookRecord`: `provider` (`openlibrary|googlebooks|bnf|audible|audnexus`), `level` (`work|edition`), `ids {work, edition, asin, isbn13[], editionIsbn13[]}`, `title`, `subtitle`, `series[] {name, position, id}`, `authors[]`, `narrators[]`, `translators[]` (each `{name, id}`), `language`, `publisher`, `published`, `description`, `subjects[]`, `pageCount`, `durationSecs`, `covers[]`, `rating {average, count}`, `format` (`ebook|print|audio`). A field a provider lacks is `null` or `[]`; a parser never invents one.
2. A record without a title is dropped from a page and is `NotFound` for a single lookup. Audible answers an unknown ASIN with HTTP 200 and a skeleton product (`asin`, `rating`, no title): it is `NotFound` too.
3. `level`: only OpenLibrary has works (a work groups editions; `search.json` and `/works/` return `work`). Every other provider describes an edition. A work record has no ISBN of its own: `ids.isbn13` stays empty and the ISBNs that `search.json` lists for its editions go to `ids.editionIsbn13`. It also has no publisher, language or format.
4. ISBNs: every ISBN (10 or 13, hyphens or prefix tolerated) is normalised to ISBN-13 through `books::isbn::parse`, deduplicated in provider order. A value whose check digit fails is dropped.
5. `language`: ISO 639-1 when the language has one, else the ISO 639-2 code, through `normalize_language_code` (the app already uses it for subtitles and tracks, so a book and its audio file compare equal). OpenLibrary and BnF send MARC codes (`fre`), Google an ISO 639-1 tag (`fr`, region dropped), Audible and Audnexus an English name (`french`, mapped by a table of 25 names). `und` and unknown names give `null`.
6. `published` is text: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Accepted inputs: `2019`, `March 2019`, `September 17, 1999`, `17 sept. 1999` (French and English month names), `[2019?]`, `c1999`, `cop. 2020`, ISO dates and datetimes. A month outside 1-12 or an impossible day falls back to the coarser date.
7. `series.position` is text (`1.5`, `II`). The parsers never infer a series from a title: a title such as `Name (Saga, 2)` is kept as sent and the series comes from the dedicated field only. Splitting titles is the naming layer's job.
8. `description` is raw, HTML included. `covers` are largest first, `https` URLs only (any other scheme is dropped).
9. `rating.average` is out of 5, clamped to 0..5 and rounded to two decimals; a non-finite value gives no rating.
10. `ParseError`: `Malformed` (not the expected JSON or XML), `NotFound`, `Moved` (OpenLibrary redirect or deletion, with the target key), `RateLimited` (quota or rate limit body: skip the provider), `Api` (any other error body). An HTTP status is the client's to read; the parsers recognise the error bodies the providers send.
11. Builders taking an id or a free query return `Option<String>`: `None` for an invalid id (path characters, wrong shape) or an empty query. Query strings are percent-encoded by `url`.

## OpenLibrary

Anchor provider (`plans` 3.4). Work vs edition: `search.json` and `/works/{id}.json` give works, `/books/{id}.json`, `/isbn/{isbn}.json` and `/works/{id}/editions.json` give editions.

Endpoints (`https://openlibrary.org`):

| Lookup | Builder | Parser |
|---|---|---|
| Search by title, author, isbn, free text | `/search.json?title=&author=&isbn=&q=&lang=&limit=&page=` plus a fixed `fields=` list | `parse_search` (works) |
| By ISBN | `/isbn/{isbn13}.json`, answers 302 to the edition: the client follows it | `parse_edition` |
| ISBN batch | `/api/books?bibkeys=ISBN:a,ISBN:b&format=json&jscmd=data` | `parse_isbn_batch` |
| Edition | `/books/{OL...M}.json` | `parse_edition` |
| Work | `/works/{OL...W}.json` | `parse_work` |
| Editions of a work | `/works/{OL...W}/editions.json?limit=&offset=` | `parse_editions` |
| Author | `/authors/{OL...A}.json` | `parse_author` (`PersonRecord`) |
| Cover | `https://covers.openlibrary.org/b/id/{coverId}-L.jpg` | built by the parsers from `covers` and `cover_i` |

Rate limits (for the 0.11 limiter):

- Default 1 request per second; identified requests (a `User-Agent` with the application name and a contact email or phone) get 3 per second; "violations may result in aggressive rate limiting or blocking". Source: `https://openlibrary.org/developers/api`, checked 2026-11-01. The plan's `metadata_contact_email` setting maps to the identified tier.
- Covers: 100 requests per IP per 5 minutes, answered 403 beyond it, only for access by ISBN, OCLC or LCCN; access by cover id or OLID is exempt. Source: `https://openlibrary.org/dev/docs/api/covers`. The builders only emit cover-id URLs, so the limit never applies.
- Observed: no rate-limit headers on `search.json`, `/isbn`, `/works`, `/authors` (about eight requests, 1.2 s apart).

Identification: the OLID is the identity (`OL...W` work, `OL...M` edition, `OL...A` author). An ISBN identifies an edition, never a work: `/isbn/` returns the edition, its `works[0]` is the work. A `/type/redirect` document (merged record) parses as `Moved(target)`: follow it once and update the stored id; `/type/delete` is `Moved(None)`; `{"error":"notfound"}` is `NotFound`. Edition and work `authors` are references only (key, no name): `Person.name` is `null` and the author lookup fills it. `search.json` carries names and keys side by side (the lists can differ in length).

Attribution and terms: the plan states the data is CC0, but `https://openlibrary.org/developers/licensing` (read 2026-11-01) names no licence: it says the Internet Archive "does not assert any new copyright or other proprietary rights" over the database and warns that "there may be existing rights issues on some contributions". Confirm the licence and the cover terms before release; the API page asks that the application identify itself in the `User-Agent`.

Field mapping:

| `BookRecord` | edition | work | search doc |
|---|---|---|---|
| `ids.edition` / `ids.work` | `key`, `works[0].key` | `key` | `key` (work) |
| `ids.isbn13` | `isbn_13`, `isbn_10` | none | none |
| `ids.editionIsbn13` | none | none | `isbn` |
| `title`, `subtitle` | `title`, `subtitle` | same | same |
| `series` | `series[]` strings (`Name ; 2`, `Name, #2` split, else name only) | none | none |
| `authors` | `authors[].key` (id only) | `authors[].author.key` (id only) | `author_name[]` with `author_key[]` |
| `translators`, `narrators` | `contributors[]` with role containing `translat`, `narrat` or `read by` | none | none |
| `language` | `languages[0].key` | none | none (the list mixes every edition) |
| `publisher` | `publishers[0]` | none | none |
| `published` | `publish_date` | `first_publish_date` | `first_publish_year` |
| `description` | `description` (string or `{type, value}`) | same | none |
| `subjects` | `subjects` | `subjects` | `subject` |
| `pageCount` | `number_of_pages` (0 ignored), else the last `N p` of `pagination` | none | `number_of_pages_median` |
| `covers` | `covers[]` ids above 0 | same | `cover_i` |
| `rating` | none | none | `ratings_average`, `ratings_count` |
| `format` | `physical_format` (audio: `Audio CD`, cassette; ebook: `Ebook`, `Kindle`; print: paperback, hardcover...), else `null` | none | none |

## Google Books (keyless)

Endpoints (`https://www.googleapis.com/books/v1`): `GET /volumes?q=` with `isbn:{isbn13}`, `intitle:`, `inauthor:` terms joined by a space, free text after them, plus `printType=books`, `langRestrict`, `maxResults` (max 40), `startIndex`; `GET /volumes/{id}`. Parsers: `parse_volumes` (page), `parse_volume`. No `key` parameter is ever sent.

Rate limits:

- Google documents no figure for keyless access on the API pages (`developers.google.com/books/docs/v1/using`, `.../getting_started`, checked 2026-11-01); they only say public-data requests need an identifier, an API key or a token.
- Observed 2026-11-01, from this machine: every keyless request (three, up to 5 s apart) answered HTTP 429, `status RESOURCE_EXHAUSTED`, `reason rateLimitExceeded`, with `quota_limit: defaultPerDayPerProject` and `quota_limit_value: "0"` for the shared anonymous project. Keyless Google Books has a zero daily quota at the time of writing: the provider must be treated as unavailable and skipped (`ParseError::RateLimited`), as the plan already does when the daily quota is exhausted. The fixture `error-quota.json` is that body with the project number replaced. The volume shapes of the other fixtures come from the documented `volumes` resource (`developers.google.com/books/docs/v1/reference/volumes`), not from a live response.
- Google's own default for a keyed project is not stated on the pages checked.

Identification: the volume `id` is an edition id (`ids.edition`). `industryIdentifiers` of type `ISBN_13` and `ISBN_10` are trusted; `OTHER` (`PKEY:`, `OCLC:`) are ignored. Search by ISBN first, title and author only as a fallback (titles often embed the series, volumes of one work are separate records). `intitle:` and `inauthor:` take quoted phrases; a `"` inside the input is replaced by a space.

Attribution and terms: the Books API terms (`https://developers.google.com/books/terms`, read 2026-11-01) have three sections: no fee may be charged to users of the application, content must be removed on a rights claim or a Google request, and users must be told that content they submit through the API may be made public. Attribution and branding are in a separate Branding Guidelines page that was not read; check it before showing Google descriptions or covers. Covers are Google's thumbnails (`http://books.google.com/books/content?...`, rewritten to `https`, `edge=curl` dropped).

Field mapping:

| `BookRecord` | Source |
|---|---|
| `ids.edition` | `id` |
| `ids.isbn13` | `volumeInfo.industryIdentifiers` (`ISBN_13`, `ISBN_10`) |
| `title`, `subtitle` | `volumeInfo.title`, `subtitle` |
| `series` | none: `seriesInfo` carries a series id and a number but no series name, so it is not parsed |
| `authors` | `volumeInfo.authors[]` (names only) |
| `language` | `volumeInfo.language` |
| `publisher`, `published` | `publisher`, `publishedDate` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) |
| `description` | `volumeInfo.description` (HTML) |
| `subjects` | `categories[]` (raw, `A / B / C`), deduplicated |
| `pageCount` | `pageCount` (0 ignored) |
| `covers` | `imageLinks` `extraLarge` down to `smallThumbnail` |
| `rating` | `averageRating`, `ratingsCount` |
| `format` | `saleInfo.isEbook` true: `ebook`, false: `print`, absent: `null` |

`items` is absent when `totalItems` is 0 (an empty page, not an error). A volume without `volumeInfo.title` is dropped.

## BnF catalogue (SRU)

Endpoint: `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=&recordSchema=unimarcxchange&startRecord=&maximumRecords=` (GET, no authentication). Builders: `isbn_url` (`bib.isbn adj "{isbn13}"`), `title_author_url` (`bib.title all "..." and bib.author all "..." and bib.doctype any "a"`), `record_url` (`bib.persistentid any "ark:/12148/{cb...}"`). Parsers: `parse_search` (page), `parse_record` (first record).

Record schema: `unimarcxchange` (UNIMARC in the marcxchange envelope). The documented schemas are `unimarcXchange`, `intermarcXchange` (each with an `-anl` analytic variant) and `dublincore`. Dublin Core was compared and rejected: it merges roles into `creator`/`contributor` text (`Name, Date. Role`), puts the ISBN in an `identifier` string (`ISBN ...`), the page count in free `format` text, and has no series, subtitle or translator. UNIMARC has one numbered field per fact and role codes, and its tags are the ones every library tool documents. Intermarc is BnF's native format with a denser, less documented tag set. The probe also showed `bib.isbn` finding nothing for an ISBN the catalogue does not hold (`numberOfRecords` 0, `<srw:records/>`), and `bib.title` alone returning DVDs and scores first, hence `bib.doctype any "a"` (printed text, observed to filter them out) on title queries.

Rate limits: none published. The API page (`https://api.bnf.fr/fr/api-sru-catalogue-general`, checked 2026-11-01) states no usage limit; it pages with `startRecord` and `maximumRecords`. Observed: no rate-limit header, no refusal over about a dozen requests 1.5 s apart. Start at the plan's 1 request per second and lower it on HTTP 429 or 503.

Identification: the ark name (`cb99900011d` in `ark:/12148/cb99900011d`) is the notice id, an edition (`ids.edition`). The ISBN (010 `$a`, hyphenated; 073 `$a` EAN) is the cross-provider key. An authority record number (`$3` of 7xx) identifies a person at the BnF (`Person.id`); the ISNI is in `$o`. BnF holds French legal-deposit books: expect a record for most French ISBNs and none for foreign or very recent ones.

Attribution and terms: BnF open data under the Licence Ouverte (Etalab): reuse is free, with the source and the date of the last update credited ("source: BnF, catalogue general"). The API page names the licence; the reuse-conditions page was not readable in this run, so confirm the exact credit line before release.

Diagnostics: a `<diagnostics>` block (for example `info:srw/diagnostic/1/10`, query syntax error) is `ParseError::Api(message)`. Title and author terms are quoted CQL strings: a backslash, `"`, `*`, `?` and `^` inside them are escaped with a backslash (`Who?` becomes `Who\?`).

Field mapping (UNIMARC, tag `$subfield`):

| `BookRecord` | Source |
|---|---|
| `ids.edition` | `mxc:record@id` (`ark:/12148/cb...`) |
| `ids.isbn13` | 010 `$a`, 073 `$a` (010 `$z`, cancelled ISBN, ignored) |
| `title` | 200 `$a`, then `. {$i}` when a part title is present |
| `subtitle` | 200 `$e` |
| `series` | 461 `$t` / `$v` / `$0` (linked entry, preferred); else 225 `$a` / `$v`; else, with only a volume number in 200 `$h`, the 200 `$a` title as the series and `$h` as the position |
| `authors` | 700, 701 with `$4` absent or `070`, 702 with `070` only: `{$b} {$a}`, id `$3` |
| `translators` | 700-702 with `$4` `730` |
| other roles | `$4` of any other value (preface, illustrator, editor...) is skipped; 710-712 (collectives) are skipped |
| `language` | 101 `$a` (first; `$c` is the original language) |
| `publisher`, `published` | 214 (210 for older records) `$c`, `$d`, skipping manufacture (`ind2` 3) |
| `description` | 330 `$a` |
| `subjects` | 606 `$a`, 608 `$a` (deduplicated) |
| `pageCount` | last `N p` in 215 `$a` (`XII-410 p.` gives 410) |
| `format` | 182 `$c` (RDA media): `n` print, `c` ebook, `s` audio |
| `covers` | none: the 856 cover is an internal numeric id, not a stable URL |
| `narrators`, `rating` | none |

## Audible catalog (unofficial)

Endpoints: `https://api.audible.{tld}/1.0/catalog/products?title=&author=&narrator=&keywords=&num_results=&page=&response_groups=&image_sizes=&products_sort_by=Relevance` and `.../products/{asin}?response_groups=&image_sizes=`. `response_groups` is `contributors,media,product_attrs,product_desc,product_details,product_extended_attrs,rating,series,category_ladders`; `image_sizes` `1024,500`. `num_results` is at most 50. Parsers: `parse_search` (page), `parse_product` (`{product: {...}}`).

Regions (`audible::Region`, a builder parameter): `us` com, `uk` co.uk, `fr`, `de`, `it`, `es`, `ca`, `au` com.au, `jp` co.jp, `in`. The code is also the Audnexus `region`. A book exists under the same ASIN in several regions, with a regional title and language; the catalogue of one region does not return another's books (an unknown ASIN is a skeleton, rule 2). Search the library's own region first.

Rate limits: none published (the API is undocumented). Observed: no rate-limit header (the service sits behind CloudFront), no refusal over four requests 1.5 s apart. Use the plan's cautious 1 request per second, lowered on 429.

Identification: the ASIN is the identity of one audio edition and so of one narrator (`ids.asin`). Authors carry their own ASIN (`Person.id`); narrators have none. `isbn` is the ISBN of the print edition when Audible has it, often empty. Series entries carry their ASIN and a `sequence` (`1.5`, sometimes a word or numeral): kept as text. A book can sit in two series (a main one and a world): both are returned, in Audible's order, primary first.

Attribution and terms: not an official API: use is outside any published terms, so keep the plan's "unofficial API" mention in the UI, fall back to the other providers on any failure, and send no credentials. Covers and text are Audible's.

Field mapping:

| `BookRecord` | Source |
|---|---|
| `ids.asin`, `ids.isbn13` | `asin`, `isbn` |
| `title`, `subtitle` | `title`, `subtitle` (often a series label such as `Name 2`) |
| `series` | `series[]`: `title`, `sequence`, `asin` |
| `authors`, `narrators` | `authors[]`, `narrators[]`: `name`, `asin` when present |
| `language` | `language` (English name) |
| `publisher` | `publisher_name` |
| `published` | `release_date`, else `issue_date`, else `publication_datetime` |
| `description` | `publisher_summary` (HTML), else `merchandising_summary`, else `extended_product_description` |
| `subjects` | `category_ladders[].ladder[].name`, deduplicated |
| `durationSecs` | `runtime_length_min` times 60 (0 ignored) |
| `covers` | `product_images`, largest size first |
| `rating` | `rating.overall_distribution` `average_rating`, `num_ratings` (absent when no rating) |
| `format` | always `audio` |

## Audnexus

Endpoints (`https://api.audnex.us`): `/books/{asin}?region=`, `/books/{asin}/chapters?region=`, `/authors/{asin}?region=`. Without `region` the API answers for `us`. Parsers: `parse_book`, `parse_chapters` (`Chapters {asin, runtimeMs, accurate, brandIntroMs, brandOutroMs, chapters[{title, startMs, lengthMs}]}`), `parse_author` (`PersonRecord`).

Rate limits: the public instance sends `x-ratelimit-limit: 300`, `x-ratelimit-remaining` and `x-ratelimit-reset` (seconds to the reset) on every answer, including 404 (observed 2026-11-01, four requests): 300 requests per window, the reset header counting down from at most 60, so a one-minute window. The project README documents a configurable `MAX_REQUESTS`, "Maximum number of requests per 1-minute period from a single source (default: 100)", and a 429 body `RATE_LIMIT_EXCEEDED` with `retryAfterSeconds` (example 60); `ParseError::RateLimited` covers it. The limiter should read the headers, not hard-code 300. Start at 1 request per second (the plan's "prudent").

Successor: the README says "AudiobookDB" is "the successor to this API" and "New projects should start there", while "audnexus remains online and maintained" (checked 2026-11-01 on the project repository). The plan asked to recheck this at coding time: the parsers target Audnexus today; AudiobookDB was not evaluated (out of the task) and is the thing to look at before relying on Audnexus for chapters long term.

Identification: ASIN, the same as Audible's. An unknown ASIN, or one absent from the asked region, answers 404 with `error.code` `REGION_UNAVAILABLE` (the message names the region): `NotFound`, and the caller may retry another region. `isAccurate: false` means the chapters were derived, not read from the file.

Attribution and terms: the data is Audible's, scraped and served by a community project; no terms are published on the instance or in the README for the public instance. Same "unofficial" stance as Audible; cache chapters by ASIN without expiry as the plan says, which also keeps the load on the public instance low.

Field mapping:

| `BookRecord` | Source |
|---|---|
| `ids.asin`, `ids.isbn13` | `asin`, `isbn` |
| `title`, `subtitle` | `title`, `subtitle` |
| `series` | `seriesPrimary`, `seriesSecondary`: `name`, `position`, `asin` (a `null` entry is skipped) |
| `authors`, `narrators` | `authors[]`, `narrators[]`: `name`, `asin` when present |
| `language` | `language` (English name) |
| `publisher`, `published` | `publisherName`, `releaseDate` (ISO datetime, date kept) |
| `description` | `summary` (HTML, full), else `description` |
| `subjects` | `genres[].name`, deduplicated |
| `durationSecs` | `runtimeLengthMin` times 60 (0 ignored) |
| `covers` | `image` (one URL) |
| `rating` | `rating` (a string such as `4.4`; non-numeric ignored), no count |
| `format` | always `audio` |

A chapter without `startOffsetMs` or `lengthMs` is dropped; a blank title is kept as an empty string so chapter positions do not shift.
