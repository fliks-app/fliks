# Spec: book metadata seams

Scope: how book providers plug into the metadata orchestrator: trait semantics, the one mapping from a parsed record to merge keys, snapshot keys, the identification and linking seams, the wire shapes of the metadata routes. The parsers are `book-providers.md`; the orchestrator is `metadata-orchestrator.md`; the data model is `books.md`. After the contract PR this file belongs to the fusion and linking track, which adds linking levels, field orders, the edition merge, provenance, identify thresholds, the routes and settings as rules 7 onward.

## Trait semantics

1. `MetadataProvider::supports(Book)` is true for the book providers. `search` answers record objects (rule 4) of works or editions; `fetch_work(Book, olid)` is OpenLibrary only (the others answer `Upstream` "unsupported"); `fetch_children(Book, olid)` is the editions of a work; `child_stubs` is `[]`; `find_by(Isbn | Asin, value)` is the work id a provider knows; `fetch_person` is an author; `person_credits` is unused for books.
2. `Search` carries `title`, `author`, `author_id`, `isbn`, `language` and `page` beside `kind`, `query` and `year`; a provider reads the fields it knows and ignores the rest. `EditionRef { namespace, value }` names an edition by an id namespace: `(Isbn, "978...")`, `(Asin, "B0...")`, `(OpenLibrary, "OL...M")`.
3. `fetch_edition(&EditionRef)` answers one edition record (rule 4 keys), `None` without a call for a namespace the provider cannot look up. `fetch_chapters(asin)` answers the `audnexus::Chapters` JSON, `None` when unsupported. Both default to `None`.

## Record keys

4. A book record is a JSON object keyed by the `Field::keys` names: `title`, `subtitle`, `overview`, `year`, `releaseDate`, `posterUrl`, `rating`, `authors`, `narrators`, `translators`, `series` (each `{name, id}`; series `{name, position, id}`), `language`, `publisher`, `pageCount`, `durationSeconds`, `format`. The mapping from a parsed provider response to these keys belongs to the provider plugin, not to the server.

5. A key no `Field` owns (a plugin may add `subjects` or id keys) is merged by provider order like the others and carries no provenance. `Field::is_empty` treats `pageCount: 0` and `durationSeconds: 0` as empty.
6. Snapshot keys are `(provider, resource, 'book', externalId, language)` with `resource` in `work | children | edition | person | chapters`; an edition read through a foreign namespace is keyed `externalId = '<namespace>:<value>'`. Audnexus chapters are `('audnexus', 'chapters', 'book', <asin>, '')` and never expire. TTL: work and edition 30 days, chapters none.

## Seams

`metadata::books::identify::identify(st, &BookHints, Priority) -> Result<Option<BookMatch>, MetaError>` finds the work and the edition ids of a set of hints (ISBNs, ASIN, title, authors, narrators, language, series, year, family). `metadata::books::link::attach(st, media, edition, &BookMatch, Priority)` links the work and edition ids, fetches, merges and writes the work and edition facts, the credits and the series.

**Rule for ingest and import alike:** files, editions, items and parts are written by the ingest side; external ids, facts, credits and series only by `attach`. Neither side writes the other's tables.

No provider client, registry entry, upstream-URL or provider setting (`metadata_contact_email`, `google_books_api_key`) is part of the contract: how book providers are hosted is open (`plans/phase1-contracts.md` is revised separately). A provider that answers the trait of rules 1-3 plugs in as any other.

## Field orders and the merge

7. `FieldOrder::book(family, first)` (`fliks_domain::metadata::merge`) holds one order per field. The default is `openlibrary`, `bnf`, `googlebooks`, `audible`, `audnexus`; `first` (the media's, then the library's preferred provider) goes ahead of it in every field. Four fields have a head of their own, then the default: `overview` and `posterUrl` `googlebooks`, `openlibrary`; `series` `openlibrary`, `bnf` for a text edition and `audible` for an audio one; `narrators` `file`, `audible`. `FieldOrder::new(Book, first)` is the text order; video orders are unchanged. A provider missing from a field's order ranks after the ones listed, so a `file` record is the last resort of every other field. The chapters order (probe, CUE, then Audnexus) is not a merge: nothing writes chapters (`plans/phase1-contracts.md` section 1.6).
8. Two merges per `attach`, both through `merge` with the locked fields of their own level: the work merge over the work record and the edition records, whose `title`, `subtitle`, `overview`, `year`, `posterUrl`, `rating`, `authors`, `series` and `releaseDate` are written to the work; the edition merge over the edition records only, whose `title`, `language`, `publisher`, `pageCount`, `durationSeconds`, `format`, `narrators`, `translators` and `releaseDate` are written to the edition. Each level stores only the provenance of its own fields. A `file` record, when the caller has one (`attach_with`), joins both merges.
9. Edition records are read for every ref of the match (rule 10) from every available provider that supports `book`, through the `edition` snapshot of rule 6. A provider that fails or answers `None` is skipped (logged), so an unlinked or throttled provider never fails an attach; the work record of the anchor does, and the anchor's absence fails with an `Upstream` error.

## Linking

10. The work anchors on OpenLibrary (`BookMatch.work`, an `OL...W` id, stored in `media_external_ids`; `external_ids::link` leaves the media unlinked and `attach` logs when another work holds the id). The edition ids of a match are `isbn`, `asin`, `openlibrary` (`OL...M`), `googlebooks` and `bnf`, stored in `edition_external_ids`. A match given with no edition writes none and reads none: an ASIN is only ever stored on an edition. Besides the ids of the match, `attach` stores the ids the edition records carry: `isbn13` (list), `asin` and `externalId` (the record's own id in its provider's namespace, kept for the three namespaces that name editions). `attach` adds ids and never removes one.
11. Record keys no `Field` owns that `attach` reads: `externalId`, `isbn13`, `asin`, `subjects` (list, written to `book_details.subjects`).
12. `identify(st, hints, priority)` answers the work and the edition ids of the hints:
    - by ISBN, then ASIN: the first provider whose `find_by` answers an `OL...W` work id wins, confidence 100;
    - otherwise, with a title, one `search` of the anchor (title, first author, year, language) whose results carry an `externalId` of a work; each is scored by `fliks_domain::metadata::book_match::score` (title up to 60, authors up to 30, year up to 10) and the best at `MIN_CONFIDENCE` (85) or more wins with its score; below it the answer is `None` (a manual link, never a guess);
    - hints with an ASIN or an ISBN and no title read the first edition record that has one, to take its title and authors;
    - the edition ids of a match are the hinted ISBNs and ASIN, normalised; hinted narrators and series are not scored.
    A provider whose `find_by` or edition read fails is skipped; a failing anchor search fails `identify` (the caller retries); a missing anchor answers `None`.
13. The writes of `attach` run in one transaction after every read: the media's `title`, `year`, `overview`, `posterUrl` and `rating` keep their value for a locked or absent field (`COALESCE`); `book_details` takes `subtitle` and `subjects`; the work release date is the `release` row with a NULL `editionId`, the edition's its own row. A release date given as `YYYY` or `YYYY-MM` is stored on the first day. `title` on the edition is NULL when it equals the work's. `format` must match the column check and `pageCount` and `durationSeconds` be positive, else the column keeps its value. The poster is downloaded to the image store after the transaction, the remote URL standing until then. The edition cover is not written: no image target names an edition. One advisory lock (`books:link`) serializes the transactions of two attaches, since persons and series are found by name.
14. Credits: `authors` replace the media's `author` credits with a NULL `editionId`; `narrators` and `translators` replace the credits of their role on the edition (a match with no edition writes none). A locked field leaves them as they are, and so does an empty list. A person is found by its provider id (`openlibrary` `OL...A`, `asin` for Audible and Audnexus, `bnf` six to twelve digits, from the record's provider), else by its case-insensitive name, else created; an id the person lacks is added, and a `sortName` (`fliks_domain::persons::sort_name`) is filled when it is NULL, never overwritten.
15. Series: the merged `series` entries become work-level `collection_entries` of the media, replacing its previous ones (an empty list changes nothing), and a collection left empty is deleted. A series is found by its id (`asin` for Audible, `bnf` for BnF), else by case-insensitive name among the collections of books that share an author with this one, else created. `position` is the number of `1`, `1.5`, `01`; any other label (`II`) keeps `position` NULL and is the `positionLabel`.
16. `edition_field_sources` and `media_field_sources` hold the provenance of rule 8, replaced in the same transaction and never touching a locked row. A `file` provenance is stored as `file`.
17. `attach` converges: a second call with the same match writes the same rows (the poster URL goes remote then local again). `link::stored(db, media, edition)` rebuilds the match a refresh passes to `attach` from the stored ids, and `attach_with` takes a `file` record besides.

## Wire shapes

```ts
// GET /api/metadata/search/book?q=&title=&author=&isbn=&language=&page=
export interface BookSearchResult {
  provider: 'openlibrary' | 'audible' | 'googlebooks' | 'bnf'; externalId: string; kind: 'book';
  title: string; subtitle: string | null; authors: string[]; year: number | null; coverUrl: string | null;
  series: { name: string; position: string | null } | null; editionCount: number | null;
  mediaId: number | null;          // already in a library the caller can read
}
// GET /api/metadata/{provider}/book/{externalId}: the add preview
export interface BookPreview extends BookSearchResult {
  description: string | null; subjects: string[]; published: string | null; language: string | null;
  editions: { provider: string; externalId: string; family: BookFormatFamily; format: string | null;
              language: string | null; title: string | null; publisher: string | null; published: string | null;
              isbn13: string[]; asin: string | null; coverUrl: string | null; narrators: string[];
              durationSeconds: number | null; pageCount: number | null }[];
  unofficial: boolean;             // true when a field comes from Audible or Audnexus
}
// POST /api/media/import body adds { type: 'book', provider: 'openlibrary', externalId, libraryId?, folderId? }
//   201 = the MD of the created book. Phase 1 offers Add only (books.md rule 17).

// GET/PUT/DELETE /api/media/:id/sources
export interface BookSources {
  work: { provider: 'openlibrary'; value: string } | null;
  editions: { editionId: number; ids: BookEdition['externalIds'] }[];
}
// PUT /api/media/:id/sources {level: 'work'|'edition', editionId?, provider, value} -> BookSources (relinks and refreshes)
// DELETE /api/media/:id/sources?level=&editionId=&provider=&value= -> BookSources
```
