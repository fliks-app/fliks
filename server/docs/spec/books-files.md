# Spec: book files

Scope: the pure parsers of the books ingest (`fliks_domain::books`): ISBNs, EPUB package metadata, file and folder names, the KOReader partial MD5. No route, no event, no job, no consumer yet: reading the archive (`zip`), listing folders and hashing a real file belong to `crates/server`, which hands these functions bytes, a path string or a `read_at` closure. Golden vectors: `fixtures/books-opf`, `fixtures/books-names`, `fixtures/books-koreader` (`crates/domain/tests/books.rs`, `BLESS=1`), all synthetic.

## Callers

| Function | Module | Input |
|---|---|---|
| `isbn::parse` | `books::isbn` | one identifier string |
| `opf::parse`, `opf::container_rootfile`, `opf::resolve_href` | `books::opf` | OPF bytes, `META-INF/container.xml` bytes, two path strings |
| `filename::parse_path` | `books::filename` | a library-relative path |
| `koreader::partial_md5` | `books::koreader` | `read_at(offset, len) -> Result<Vec<u8>, E>` |

## ISBN

1. `isbn::parse(raw) -> Option<Isbn { isbn13, isbn10 }>` accepts an ISBN-10 or an ISBN-13, upper-cased, with an optional `urn:` and `isbn`, `isbn10`, `isbn-13` prefix (any case, followed by `:` or spaces) and with hyphens, spaces and no-break spaces removed.
2. An ISBN-13 starts with `978` or `979` and an ISBN-10 is nine digits and a digit or `X`; each must pass its checksum, otherwise the result is `None` (a bad identifier is dropped, never repaired).
3. `isbn13` is always set: an ISBN-10 is converted by prefixing `978` and recomputing the check digit. `isbn10` is set for an ISBN-10 and for a `978` ISBN-13, and is `None` for a `979` one.

## Package metadata

4. `opf::parse(bytes) -> OpfMetadata` never fails. Text is decoded first: a BOM decides, else the `encoding` of the XML declaration (`encoding_rs` labels), else UTF-8, else, when the bytes are not UTF-8, windows-1252. A document that is not XML, is empty or has no `metadata` element gives the empty value.
5. The reader is a tag-soup tolerant tree: element and attribute names are matched by their lower-cased local name, so prefixes, undeclared namespaces and an unprefixed OPF read alike (`opf:role` is `role`, `dc:title` is `title`). An end tag closes the nearest open element of its name and is ignored when none is open; a malformed tail ends the read and keeps what was read.
6. References are decoded once: numeric ones, `&amp; &lt; &gt; &quot; &apos;` and `&nbsp;` (U+00A0); any other name stays as written (`&eacute;`). CDATA is taken literally.
7. The result serialises in camelCase and omits absent values; lists are always present. Values are trimmed with their inner whitespace collapsed, except the description (rule 16), which is only trimmed.
8. Title: among the non-empty `dc:title`, the one an EPUB 3 `refines` `title-type` marks `main`, else the first without a `title-type`, else the first.
9. Sort title: the `file-as` of that title (attribute or `refines`), else `meta name="calibre:title_sort"`.
10. Subtitle: the title whose `title-type` is `subtitle` (EPUB 3 only).
11. Creators come from `dc:creator` and `dc:contributor`, in document order, each with `name`, `role` and `fileAs` (the `file-as` attribute, else the `refines` `file-as`). The role is the `role` attribute (EPUB 2) else the `refines` `role` (EPUB 3), compared lower-cased.
12. Roles kept: `aut` (author), `nrt` (narrator), `trl` (translator), `edt` (editor), `ill` (illustrator). A `dc:creator` without a role is `aut`; a `dc:contributor` without a role, any other code (`bkp`, `oth`, `pbl`) and an empty name are dropped. A repeated (name, role) is kept once. A name is kept as written (`Last, First` is not reordered); one element is one person (`A & B` is not split).
13. Language: the first non-empty `dc:language`, as `normalize_language_code` (`fre` and `fr-FR` give `fr`); `und` is absent.
14. Publisher: the first non-empty `dc:publisher`.
15. Date: the `dc:date` with `event="publication"`, else the first whose event is not `creation` or `modification`, else the first. `year` is its leading four digits, else its first four-digit group, and must be 1000 to 2100; without a valid year both `date` and `year` are absent (calibre's `0101-01-01` placeholder is thereby ignored). `date` is the text as written.
16. Description: the first non-empty `dc:description`, raw (an escaped `&lt;p&gt;` reads back as `<p>`); sanitising is the consumer's job.
17. Subjects: every non-empty `dc:subject`, in order, without duplicates; a comma inside one is not split.
18. Identifiers: each `dc:identifier` has a scheme, the `scheme` attribute (EPUB 2) else the `refines` `identifier-type` (EPUB 3), lower-cased, and a value. A `urn:<scheme>:<value>` or `<scheme>:<value>` value for `isbn`, `uuid`, `asin`, `mobi-asin`, `amazon`, `google` or `goodreads` supplies the scheme and strips the prefix.
19. `asin` (schemes `asin`, `mobi-asin`, `amazon`), `google` (`googleId`), `goodreads` (`goodreadsId`) and `uuid` (lower-cased) keep the first value of their scheme. Any other identifier is an ISBN when `isbn::parse` accepts it, whatever its scheme or none; a value of no scheme that has a UUID shape is the `uuid` when none is set yet. Everything else (`calibre`, `uri`, opaque ids) is ignored.
20. `isbns` lists every ISBN of the identifiers, then of `dc:source` (EPUB 3 keeps the print edition's ISBN there), in order and without duplicates by `isbn13`. A tagged ISBN whose checksum fails is not listed.
21. Series, EPUB 3: a `meta property="belongs-to-collection"` that does not itself refine another element names the series; the one whose `collection-type` is `series` wins, else the first without a collection type (`set` and other types are ignored). Its position is the `group-position` refining it.
22. Series, calibre: `meta name="calibre:series"` and `calibre:series_index`, used only when rule 21 found nothing.
23. A position is a number, `,` accepted as the decimal separator (`1,5` is 1.5); anything else leaves the series with no position.
24. Cover, EPUB 3: the first manifest `item` whose `properties` has the token `cover-image`; its `href`, as written.
25. Cover, EPUB 2: the manifest `item` whose `id` is the `content` of `meta name="cover"`, when its `media-type` is an image or is absent (a cover page in XHTML is not a cover).
26. Cover, fallback: the first manifest `item` with an image `media-type` whose `id` contains `cover`. Otherwise no cover.
27. `opf::resolve_href(opf_path, href)` is the archive entry of a manifest `href`: joined to the folder of the OPF, fragment and query dropped, percent-decoded (UTF-8), `.` and `..` segments resolved (never above the root); a leading `/` is the archive root.
28. `opf::container_rootfile(bytes)` is the `full-path` of the first `rootfile` whose `media-type` contains `oebps-package`, else of the first `rootfile` with a non-empty `full-path`, else `None`; rules 4 to 6 apply.

## File and folder names

29. `filename::parse_path(path) -> BookNameGuess` reads a library-relative path (the library root is removed by the caller), `/` or `\` separated. The last component is a file, whose extension is dropped when it is a known book, audio or comic one (`epub azw azw3 mobi kfx fb2 pdf djvu txt cbz cbr cb7 m4b m4a mp3 flac ogg oga opus wma aac wav`), or an audiobook folder. The two folders above it are read as `Author` and `Author/Series`. The result has `title`, `authors`, `series`, `seriesPosition`, `narrators`, `year`, `part` and `confidence`, absent values omitted.
30. Every component is NFC-normalised, `’ ‘ ʼ ´` and the backtick become `'`, whitespace is collapsed, and `_` becomes a space in a component that has no space. Titles keep their case.
31. Brackets are read before anything else: `{X}` and `[narr. X]`, `(narrator X)`, `[read by X]`, `(lu par X)`, `[narré par X]`, `(voix X)` give narrators (several split on `,`, `&`, `et`, `and`); `(2019)` or `[2019]` (1500 to 2099) gives the year; and noise is removed: `Z-Library` and `libgen` marks, `epub mobi azw pdf m4b mp3`, `ebook`, `retail`, `audiobook`, `unabridged`, `fr`, `french`, `vf`, `64 kbps`, an ASIN (`B0` and eight characters) and anything ending in `edition` or `édition`.
32. A trailing `(...)` of the name is then read: `Series #3`, `Series, 3`, `Series, Tome 3` is a series and position, two to five capitalised words are the author (`Title (Author)`), anything else stays in the title.
33. The rest is cut on ` - ` (the en dash and the em dash count as the hyphen) and read by segment count:
    - 1 segment: the title, or a position and title for `03. Title`.
    - 2 segments: a bare number and the title (`03 - Title`); a series with a position and the title (`Series #3 - Title`, `Tome 3 - Title`, `Series 03 - Title`); else `Author - Title`, which stays a title as a whole when the author part does not look like a name.
    - 3 or more: a series and a bare number first (`Series - 03 - Title`); else, when the first segment is an author, `Author - Series 03 - Title` or `Author - Series - 03 - Title`, else `Author - Title - Subtitle` (the rest is the title).
    - A series position is `#`, `Tome`, `T`, `Vol`, `Volume`, `Book`, `Livre`, `n°` or `no.` followed by a number; in a position other than the first segment, a trailing bare number (three digits at most) counts too.
34. An author looks like a name when it has one to six words (two for `Title (Author)`), none with a digit, each capitalised, a particle (`de du des del della di da la le les van von der den`) or `d'`/`l'`-led after the first, and does not begin with an article (`les un une the an a des mon ma mes`).
35. Authors are split on `;`, `&`, `+`, `et`, `and`, `und` and on commas, except that one comma between a single word and the rest, or after a particle name (`de La Fontaine, Jean`), is `Last, First`. Each person is cleaned: `Last, First` becomes `First Last`; a leading run of capitals with a surname of three letters or more followed by a mixed-case name (`VEXMOOR Aldric`) moves to the end; a fully capitalised word of three letters or more (and a particle) is title-cased, particles and `d'`/`l'` lower-cased after the first word; initials (`J.R.`, `JK`) are untouched.
36. Folders. With no folder the name alone decides. A number-led name (a position without a series) takes its single folder as the series, and the outer one as the author. Otherwise the outer folder is the author and the inner one the series; a single folder is the author. A folder that only repeats the series or the title (case, accents and word order ignored, a calibre `(123)` suffix dropped) is not taken as a series. The name's own author wins when it agrees with the folder (the confidence rises); when it does not, the folder wins and an `Author - Title` pair stays whole as the title, except that a pair whose second part is the folder's author reads `Title - Author`.
37. Audiobook parts: for an audio file, `Part`, `Partie`, `Pt`, `Chapter`, `Chapitre`, `Chap`, `Track`, `Piste`, `Disc`, `Disque` or `CD` followed by a number (and an optional ` - title`) is a part; so is `01 - Title`, `01 Title` or `01` when the format is made of parts (not `m4b`) or the title is a generic chapter word. An `m4b` named `03 - Title` is a whole book at position 3. A part carries `part { disc, number, title }` (a generic `Chapter 1` is no title); folders named `CD1`, `Disc 2`, `Disque 1` above it give `disc`, and the book is described by the folder above them, which is read like a file stem.
38. `confidence` is the sum of 40 for a title, 30 for an author (45 when the name and a folder agree) and 10 for a series with a position, capped at 95; a path with no usable segment is 0.
39. Known ambiguities, taken as the common reading: `Title - Subtitle` against `Author - Title` is decided by rule 34 and the folders only; a `Title - Author` file with no author folder reads as `Author - Title`; a parenthesised series of two capitalised words reads as an author; `Le Clézio Anselme` (surname first, mixed case) is not reordered.

## KOReader partial MD5

40. `koreader::partial_md5(read_at) -> Result<String, E>` is KOReader's `util.partialMD5` (`frontend/util.lua` of koreader/koreader): the MD5, lower-case hex, of the concatenated reads of 1024 bytes at the offsets `lshift(1024, 2*i)` for `i` from -1 to 10, stopping at the first empty read. A short read (the end of the file) is hashed and the next read is empty. An error of `read_at` is returned, never read as the end of the file.
41. The offsets are 0, 1024, 4096, 16384, ... up to 1 073 741 824. The first is 0, not 256: KOReader runs on LuaJIT, whose `bit.lshift` masks the shift count to five bits, so `lshift(1024, -2)` is `1024 << 30`, which wraps to 0 in 32 bits. The same hash comes out of any file whose bytes at these offsets are equal, so KOReader's own caveat holds: a file sized around 1024, 4096, 16384, ... can change its digest when data is appended.
42. MD5 is implemented in the module (RFC 1321): the crate may not depend on an md5 crate.
43. `fixtures/books-koreader` was computed by running KOReader's `partialMD5`, verbatim, under LuaJIT 2.1 (`lupa`), on real files of 25 sizes (0 to 1 GiB + 2048, around every offset), with the digest done by a standard MD5 in place of `ffi/sha2`. The files' bytes are `(i*131 + (i>>7)) & 0xFF` below 2 MiB and zero beyond, which the test regenerates.
