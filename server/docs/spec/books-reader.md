# Spec: EPUB reader routes (Readium manifest and sanitised resources)

Scope: what the web reader reads of an EPUB edition: the Readium Web Publication manifest, the positions list and the resources of the archive. An EPUB comes from an indexer and its XHTML can carry script: served on the app origin it would act with the `fliks_access` cookie, so every resource is rewritten and served under a strict CSP (`plans/books-audiobooks.plan.md` section 3.8, spike `plans/reader-spike.md`). The package reader is `fliks_domain::books::package` (pure); the routes, the zip access and the rewriter are `fliks_server::books::reader`. The client reader is out of scope.

## Routes

| Route | Answer |
|---|---|
| `GET /api/books/:itemId/pub/manifest.json` | `application/webpub+json` |
| `GET /api/books/:itemId/pub/positions.json` | `application/vnd.readium.position-list+json` |
| `GET /api/books/:itemId/pub/*path` | the manifest resource at `path`, rewritten when it is markup |

`:itemId` is an item of a `text` edition with an `.epub` part. Every route needs `media.read` (`Authed`: 401, then 403).

## Access

1. The file is the first `.epub` part of the item's highest `version` (`items.md` rule 35 order, lowest `position`). It is found by one query that also applies the ACL: the media's library must be readable and no edition linking the file may sit in a library outside the readable ones (`libraries::HIDDEN_FILES_FROM`, `books.md` rule 22, the rule behind `assert_file_accessible`).
2. A missing item, an item with no EPUB part, an unreadable media and a hidden edition all answer 404 `Item #<id> not found` after the same two queries (the readable libraries, then that lookup): a hidden edition is indistinguishable from a missing one, in the answer and in the work done. A file missing on disk, or outside its folder root, is 404 as well.

## Package

3. `package::parse(opf_bytes) -> Package` never fails and reads the same tag-soup tree as `opf::parse` (`books-files.md` rule 5): the manifest items (`id`, `href`, `media-type`, `properties` tokens), the spine (`idref`, `linear`), the `toc` attribute of the spine, its `page-progression-direction` (`ltr` or `rtl`, else absent) and the layout (`fixed` when a `meta property="rendition:layout"` reads `pre-paginated`).
4. `package::nav_toc(bytes)` is the nested `ol` of the `nav` element whose `type` token list has `toc`; `package::ncx_toc(bytes)` is the `navMap` of an NCX. An entry is `{ title, href, children }` with the `href` as written; one without a title or an `href` is dropped, its children kept.

## Manifest

5. Every path is an archive entry name: the manifest `href` through `opf::resolve_href`, so `..` never leaves the root. An item whose `href` has a URL scheme or starts with `//`, or whose entry is not in the archive, is not listed and not served. Hrefs in the answer are percent-encoded per segment, relative to the `self` link.
6. The answer is `{ "@context", metadata, links, readingOrder, resources, toc }`. `metadata`: `@type` `http://schema.org/Book`, `conformsTo` the EPUB profile, `title`, `identifier` (the uuid, else `urn:isbn:` of the first ISBN, else `urn:fliks:item:<itemId>`), `language` (list), `author` (creators with role `aut`), `publisher`, `published` (the OPF `date`), `subject`, `description` when present, `readingProgression` (the spine's, else absent), `layout: "fixed"` for a fixed layout.
7. `links` holds `rel: self` (`/api/books/<itemId>/pub/manifest.json`, `application/webpub+json`) and the positions link (`rel: http://readium.org/restricted/positions`, `positions.json`, `application/vnd.readium.position-list+json`).
8. `readingOrder` is the spine items (`linear` not `no`) that exist in the archive and are XHTML (SVG and other XML spine items are not listed there: the reader cannot be given a CSP meta for them), each `{ href, type, title? }` (`title` from the toc when it names the item); `resources` is every other servable item. `toc` comes from the nav document when the manifest has an item with the `nav` property, else from the NCX named by the spine's `toc`, else `[]`; its hrefs are resolved against the document, kept when they name a listed item, with the fragment. Items, paths and toc targets are indexed by id and path, so the answer is linear in the size of the package.
9. An archive with no OPF, or an OPF over its cap (`books-files.md` rule 4), is a 404 `Item #<id> not found`: the book cannot be read. A nav document or NCX that is missing, over the markup cap (rule 13) or unreadable gives `toc: []`.

## Positions

10. One position per 1024 bytes of each reflowable reading-order resource (at least 1; the size is the declared one, capped at the markup cap), one per resource for a fixed layout; the list stops at 100 000 positions. Each is `{ href, type, locations: { position, progression, totalProgression } }` with `position` from 1, `progression` the offset in the resource and `totalProgression` the offset in the book; the answer is `{ total, positions }`.

## Resources

11. The path must be, as decoded, the archive name of a listed manifest item. Anything else is a 404: a path with an empty segment, `.` or `..`, a leading `/`, a backslash or a NUL, one that names no manifest item, an item with a URL scheme, and an archive entry that is not in the manifest (`META-INF/*`, the OPF itself). The path is only a key into the manifest: nothing is ever extracted or opened by path.
12. Servable media types are an exact allowlist (case and parameters ignored; a value with a comma, a space or anything else off the list is refused): `application/xhtml+xml`, `text/html`, `image/svg+xml`, `application/x-dtbncx+xml`, `application/xml`, `text/xml`, `application/smil+xml`, `text/css`, `image/jpeg|png|gif|webp|avif`, `font/otf|ttf|sfnt|woff|woff2`, `application/font-woff`, `application/font-woff2`, `application/vnd.ms-opentype`, `application/x-font-ttf`, `application/x-font-opentype`, `application/font-sfnt`, `audio/mpeg|mp4|aac|ogg|opus|webm|wav`, `video/mp4|webm|ogg`. Any other type, JavaScript included, is a 404 and is not listed. The answer's `Content-Type` is always the canonical allowlisted type, never the manifest string; XHTML and HTML are `application/xhtml+xml` and markup carries `; charset=utf-8`.
13. Caps, on the decompressed bytes read, whatever size the archive declares: 8 MiB for markup and 32 MiB for the others. An entry over its cap is a 413 `Resource too large`, an entry the manifest lists but the archive lacks is a 404, an unreadable entry a 404. The rewritten markup is capped the same way.
14. Markup (XHTML, HTML, SVG and the other XML types) is rewritten by a strict XML pass, never a regex. The input must be UTF-8 (a UTF-16 BOM or invalid UTF-8 is a 422 `Resource is not well-formed`) and well-formed (mismatched or unclosed tags, duplicate attributes: 422). The root element must match the declared type, else 422: an XHTML item is a `html` element in the XHTML namespace, an SVG item an `svg` element in the SVG namespace (both declared on the root), and another XML item is neither an `html` nor an `svg` element. The output declares UTF-8, drops the XML declaration, processing instructions and comments, re-emits CDATA as escaped text, and keeps a `DOCTYPE` only when it has no internal subset.
15. Elements removed with their content, whatever their namespace prefix (lower-cased local name): `script`, `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `form`, `base`, `set`, `animate`, and `meta` with an `http-equiv`. Attributes removed: every one whose local name starts with `on`, `srcdoc`, and a `href`, `src`, `action`, `formaction`, `data`, `poster` or `background` whose value, entity-decoded, with whitespace and control characters removed and lower-cased, starts with `javascript:` or `vbscript:`; an attribute whose value cannot be decoded is removed.
16. XHTML gets `<meta xmlns="http://www.w3.org/1999/xhtml" http-equiv="Content-Security-Policy" content="script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"/>` as the first child of `head` (a `head` with the same explicit namespace is created after `html` when absent), unprefixed whatever the prefix of the document. The reader injects its own scripts as blob URLs after the fetch, so the meta only constrains the book.
17. Every response of these routes (manifest and positions included) carries `Content-Security-Policy: default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private, no-cache`. The header makes a resource opened as a top-level document inert; it does not apply to a chapter in the reader's blob frame, which rules 14-16 protect.
18. The app CSP (`http/csp.rs`) allows `frame-src blob:` and `style-src blob:` for the reader's chapter frames, never `script-src blob:`.

## Known limits

19. No `Range`, no cache validators, and the zip is opened on every request. `META-INF/encryption.xml` is not read: obfuscated fonts are served as stored. A manifest entry named `manifest.json` or `positions.json` at the archive root is shadowed by the two fixed routes. Requests made by the browser inside the frame carry the cookie only, so native bundles need a path token (decided with the client, 2.6).
