# Server docs

## Spec index

Per-domain specs live under [`spec/`](spec/), one file per domain. The parity scenarios and golden vectors that pin them are described in [`../parity/README.md`](../parity/README.md).

Watch party: [`spec/watch-party.md`](spec/watch-party.md) (routes, state machine, events).

Books: [`spec/books.md`](spec/books.md) (the `book` kind, editions and their facts, ids, series, sort keys), [`spec/books-api.md`](spec/books-api.md) (routes and wire shapes), [`spec/book-metadata.md`](spec/book-metadata.md) (trait semantics, record mapping, identify and attach seams), [`spec/book-ingest.md`](spec/book-ingest.md) (ingest seams), [`spec/book-import.md`](spec/book-import.md) (bulk import job, manual queue), [`spec/books-reader.md`](spec/books-reader.md) (EPUB manifest, sanitised resources, CSP).

Item delivery: [`spec/item-delivery.md`](spec/item-delivery.md) (audio and text items: item resolve and playback-info, resolver parts, `itemId` on playback routes, progression, finished rules).

Book files: [`spec/books-files.md`](spec/books-files.md) (OPF metadata, ISBNs, file and folder names, KOReader hash).
OPDS: [`spec/opds.md`](spec/opds.md) (OPDS 1.2 catalogue on device tokens: routes, ACL, throttle, feed shapes).

Device tokens: [`spec/device-tokens.md`](spec/device-tokens.md) (credentials of readers and sync apps, hashing, scope, resolve by token).
KOReader sync: [`spec/kosync.md`](spec/kosync.md) (kosync server: routes, wire, auth by device token, document hash, shared progression).
Send to device: [`spec/email-devices.md`](spec/email-devices.md) (admin SMTP settings, e-mail devices, mailing a book edition file, limits).

Items: [`spec/items.md`](spec/items.md) (item groups, items, editions and item parts: what a media is made of).

Media details: [`spec/media-details.md`](spec/media-details.md) (release dates, the calendar and the counters).

Wants and follows: [`spec/wants-follows.md`](spec/wants-follows.md) (per-work wants, author follows, series watches, the `FollowRefresh` job, the wanted list, the calendar).


Provider plugins: [`spec/provider-plugins.md`](spec/provider-plugins.md) (the `provider` manifest block, the `metadata-provider` WIT interface, open id namespaces, Fliks defaults, bundled providers, the provider lane and its outbound limits).

Metadata providers: [`spec/metadata-orchestrator.md`](spec/metadata-orchestrator.md) (the provider trait, the registry, call priorities, the rate limiter, snapshots, the field merge, provenance and locks).
