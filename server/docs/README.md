# Server docs

## Spec index

Per-domain specs live under [`spec/`](spec/), one file per domain. The parity scenarios and golden vectors that pin them are described in [`../parity/README.md`](../parity/README.md).

Watch party: [`spec/watch-party.md`](spec/watch-party.md) (routes, state machine, events).

Books: [`spec/books.md`](spec/books.md) (the `book` kind, editions and their facts, ids, series, sort keys), [`spec/books-api.md`](spec/books-api.md) (routes and wire shapes), [`spec/book-metadata.md`](spec/book-metadata.md) (trait semantics, record mapping, identify and attach seams), [`spec/book-ingest.md`](spec/book-ingest.md) (ingest seams), [`spec/books-reader.md`](spec/books-reader.md) (EPUB manifest, sanitised resources, CSP).

Reader annotations: [`spec/annotations.md`](spec/annotations.md) (bookmarks and highlights of a text item, routes, limits).

Item delivery: [`spec/item-delivery.md`](spec/item-delivery.md) (audio and text items: item resolve and playback-info, resolver parts, `itemId` on playback routes, progression, finished rules).

Music: [`spec/music.md`](spec/music.md) (the `album` kind, release groups, releases and tracks, credits, works, ratings, the music id namespaces, the records a music provider answers and the resolution of an artist).

Comics: [`spec/comics.md`](spec/comics.md) (the `comic` kind, volumes and issues, `comic_details`, `comic_issues`, the detail and list shapes, archive ingest, the page routes and local metadata).

Book files: [`spec/books-files.md`](spec/books-files.md) (OPF metadata, ISBNs, file and folder names, KOReader hash). KEPUB conversion: [`spec/kepub.md`](spec/kepub.md).
OPDS: [`spec/opds.md`](spec/opds.md) (OPDS 1.2 catalogue on device tokens: routes, ACL, throttle, feed shapes).

OpenSubsonic: [`spec/opensubsonic.md`](spec/opensubsonic.md) (the `/rest` music API: auth, envelope, ids, endpoints, stream credential).

Device tokens: [`spec/device-tokens.md`](spec/device-tokens.md) (credentials of readers and sync apps, hashing, scope, resolve by token).
Kobo sync: [`spec/kobo.md`](spec/kobo.md) (emulated Kobo store API on a `kobo` device token: library, covers, reading state, shelves, optional store proxy).
KOReader sync: [`spec/kosync.md`](spec/kosync.md) (kosync server: routes, wire, auth by device token, document hash, shared progression).
Library optimization: [`spec/optimize.md`](spec/optimize.md) (profiles, presets, difference computation, codec choice, candidate selection, preview); remote workers: [`spec/library-optimize-workers.md`](spec/library-optimize-workers.md).
Send to device: [`spec/email-devices.md`](spec/email-devices.md) (admin SMTP settings, e-mail devices, mailing a book edition file, limits).

Scene numbering: [`spec/scene-numbering.md`](spec/scene-numbering.md) (TheXEM scene to aired mapping of releases and files).

Items: [`spec/items.md`](spec/items.md) (item groups, items, editions and item parts: what a media is made of).

Media details: [`spec/media-details.md`](spec/media-details.md) (release dates, the calendar and the counters).

Wants and follows: [`spec/wants-follows.md`](spec/wants-follows.md) (per-work wants, author follows, series watches, the `FollowRefresh` job, the wanted list, the calendar).


Provider plugins: [`spec/provider-plugins.md`](spec/provider-plugins.md) (the `provider` manifest block, the `metadata-provider` WIT interface, open id namespaces, Fliks defaults, bundled providers, the provider lane and its outbound limits).

Metadata providers: [`spec/metadata-orchestrator.md`](spec/metadata-orchestrator.md) (the provider trait, the registry, call priorities, the rate limiter, snapshots, the field merge, provenance and locks).
