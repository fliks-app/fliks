# Spec: book ingest

Scope: how book files enter the library: grouping files into editions, archive reading, tags mapping, post-import work by family, covers, the KOReader hash, identification flow, naming at ingest. The parsers are `books-files.md`; the identification and linking seams are `book-metadata.md`; the data model is `books.md`. After the contract PR this file belongs to the ingest track, which writes the rules.

## Seams

- Ingest writes files, editions, items and parts, never external ids, facts, credits or series: those go through `metadata::books::link::attach(st, media, edition, &BookMatch, Priority)` (`book-metadata.md`).
- Identification starts from `BookHints` (ISBNs, ASIN, title, authors, narrators, language, series, year, family) read from the file (`books-files.md`) and the engine's `info.tags` and `info.cover`, and calls `metadata::books::identify::identify`.
- A book gets one edition per family found, each with one ungrouped item (`books.md` rules 3 and 4). The folder of a file comes from `folder_for(library, family)` of the library folders spec.
- No engine work is part of phase 1: the server reads `hello.jobFamilies`, runs the `Cover` job and keeps `info.tags`.

## Rules

None yet. The ingest track numbers them from 1.
