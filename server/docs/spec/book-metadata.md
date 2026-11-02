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

`metadata::books::identify::identify(st, &BookHints, Priority) -> Result<Option<BookMatch>, MetaError>` finds the work and the edition ids of a set of hints (ISBNs, ASIN, title, authors, narrators, language, series, year, family). `metadata::books::link::attach(st, media, edition, &BookMatch, Priority)` links the work and edition ids, fetches, merges and writes the work and edition facts, the credits and the series. Both are stubs (`Ok(None)`, `Ok(())`) in the contract PR.

**Rule for ingest and import alike:** files, editions, items and parts are written by the ingest side; external ids, facts, credits and series only by `attach`. Neither side writes the other's tables.

No provider client, registry entry, upstream-URL or provider setting (`metadata_contact_email`, `google_books_api_key`) is part of the contract: how book providers are hosted is open (`plans/phase1-contracts.md` is revised separately). A provider that answers the trait of rules 1-3 plugs in as any other.

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
