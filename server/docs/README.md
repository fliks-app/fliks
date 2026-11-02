# Server docs

## Spec index

Per-domain specs live under [`spec/`](spec/), one file per domain. The parity scenarios and golden vectors that pin them are described in [`../parity/README.md`](../parity/README.md).

Watch party: [`spec/watch-party.md`](spec/watch-party.md) (routes, state machine, events).

Books: [`spec/books.md`](spec/books.md) (the `book` kind, editions and their facts, ids, series, sort keys), [`spec/books-api.md`](spec/books-api.md) (routes and wire shapes), [`spec/book-metadata.md`](spec/book-metadata.md) (trait semantics, record mapping, identify and attach seams), [`spec/book-ingest.md`](spec/book-ingest.md) (ingest seams).

Book files: [`spec/books-files.md`](spec/books-files.md) (OPF metadata, ISBNs, file and folder names, KOReader hash).
Items: [`spec/items.md`](spec/items.md) (item groups, items, editions and item parts: what a media is made of).

Media details: [`spec/media-details.md`](spec/media-details.md) (release dates, the calendar and the counters).

Book metadata providers: [`spec/book-providers.md`](spec/book-providers.md) (endpoints, rate limits, identification, field mappings of OpenLibrary, Google Books, BnF, Audible, Audnexus).

Provider plugins: [`spec/provider-plugins.md`](spec/provider-plugins.md) (the `provider` manifest block, the `metadata-provider` WIT interface, open id namespaces, Fliks defaults, bundled providers, the provider lane and its outbound limits).

Metadata providers: [`spec/metadata-orchestrator.md`](spec/metadata-orchestrator.md) (the provider trait, the registry, call priorities, the rate limiter, snapshots, the field merge, provenance and locks).
