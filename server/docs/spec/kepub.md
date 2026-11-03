# KEPUB conversion

The `kepub` crate (`crates/kepub`) converts an EPUB to a KEPUB, in pure Rust. It ports kepubify's
default transforms (MIT, see `THIRD-PARTY-NOTICES.md`).

1. The archive is read through `Limits`: entry count, declared size per entry (512 MiB), declared
   total (2 GiB), and 8 MiB per document parsed in memory (package, container, content). Entries
   with an absolute path, `..`, a backslash, a NUL or a drive prefix are dropped, as are directory
   entries and later duplicates of a name.
2. `mimetype` is written first, stored. Entries keep their order. Entries that are not rewritten are
   copied raw, without decompression, so any compression method passes; the package and content
   documents are deflated.
3. Dropped: `calibre_bookmarks.txt`, `iTunesMetadata.plist`, `iTunesArtwork.plist`, `.DS_STORE`,
   `thumbs.db`, `Thumbs.db` (any case) and `__MACOSX/`.
4. Package: the `cover` meta (default id `cover`) adds `cover-image` to the manifest item's
   `properties`; `calibre:timestamp` metas and `contributor` with role `bkp` are removed.
5. Dummy title page: when the first linear spine document is not named `*cover*`/`*title*` and has
   more than 4 paragraphs, more than 20 words or more than 4 images, or has neither images nor 5
   words (paragraph text is not counted), a blank page is added first in the spine.
6. Content documents (manifest media type XHTML or HTML, or extension `.htm`, `.html`, `.xhtml`):
   decoded from the BOM, else UTF-8, else the declared charset (windows-1252 when undeclared or
   unknown), then parsed leniently (HTML-style repairs, any case, the XHTML 1.x named entities, others kept literal, comments and
   the DOCTYPE internal subset dropped), then `meta` charset set to UTF-8, a `kobostylehacks`
   style appended to `head`, the body wrapped in `div#book-columns > div#book-inner`, and every
   sentence wrapped in `span.koboSpan#kobo.<paragraph>.<segment>` (images get a span of their
   own; `pre`, `script`, `style`, `svg`, `math`, `audio`, `video` are left alone). Adept metas,
   empty `o:p` / `st1:*` elements and U+FFFD are removed. Output is polyglot XHTML: `&#160;`,
   `xmlns` on `html`, void elements self-closed, others never.
7. A document that already holds a `koboSpan` is not spanned again, one that already has the two
   divs is not wrapped again.
8. Nesting past 256 levels, or more than 500,000 nodes in a document (spans included), fails the
   conversion with `Malformed`. Markup outside the first `html` element moves into its body.
