# Server docs

## Spec index

Per-domain specs live under [`spec/`](spec/), one file per domain. The parity scenarios and golden vectors that pin them are described in [`../parity/README.md`](../parity/README.md).

Watch party: [`spec/watch-party.md`](spec/watch-party.md) (routes, state machine, events).

Book files: [`spec/books-files.md`](spec/books-files.md) (OPF metadata, ISBNs, file and folder names, KOReader hash).
Items: [`spec/items.md`](spec/items.md) (item groups, items, editions and item parts: what a media is made of).

Media details: [`spec/media-details.md`](spec/media-details.md) (release dates, the calendar and the counters).

Book metadata providers: [`spec/book-providers.md`](spec/book-providers.md) (endpoints, rate limits, identification, field mappings of OpenLibrary, Google Books, BnF, Audible, Audnexus).

Metadata providers: [`spec/metadata-orchestrator.md`](spec/metadata-orchestrator.md) (the provider trait, the registry, call priorities, the rate limiter).
