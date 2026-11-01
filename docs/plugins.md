# Plugins

How the plugin system works, for whoever writes a plugin or changes core's side of it. What a
particular plugin *does* belongs in that plugin's own README.

## Two tiers

**`data`** ships JSON and executes nothing. It can contribute pages and menu entries, declare
settings, and subscribe to domain events — core makes every outbound request on its behalf. It
holds no database, answers no route, and runs no code. Installing one cannot execute anything.

**`process`** ships a WebAssembly component (`plugin.wasm`, `pluginApi` 3) that `fliks-server` runs
in a wasmtime sandbox. It answers HTTP routes through core's proxy, owns a Postgres schema, and runs
jobs on a schedule. It is the tier that can do work of its own, and the one whose failure needs
supervision.

Pick `data` unless the plugin genuinely needs to act. The tiers are not a spectrum: a `data`
plugin that needs to answer one route is a `process` plugin.

## The manifest

One `plugin.json` at the archive root, validated before anything is written. Every manifest,
`data` or `process`, must carry all of: `id`, `pluginApi`, `name`, `version`, `fliks` (a non-empty
semver range, conventionally with an upper bound, e.g. `">=2.1.0 <3.0.0"`), `author`, `description`, `license`,
`logo`, and `kind` (`data` or `process`) — the install fails if any one is missing. `homepage` is
the only identity field that's optional.

A `process` manifest additionally requires these seven keys — reference `fk-plugin-download`'s
`plugin.json` for a manifest that satisfies all of them:

- `runtime` — the only legal value is the literal `"wasm"`. (`"node"` is refused.)
- `memoryMb` — the cap on each instance's linear memory, at most 1024; larger is refused.
- `pluginApi` — the contract revision this plugin is written against. Core accepts only the values in
  its own `SUPPORTED_PLUGIN_API_VERSIONS`, which is `[3]`: a manifest declaring anything else (a
  package built for `pluginApi` 2 included) is installed but `failed` with `incompatible-api`, with no
  transition window. The admin's plugin list shows the reason, `manifest declares pluginApi 2, this
  core accepts 3; install a build of this plugin made for pluginApi 3`, and the plugin's data is kept.
- `fliks` — the core versions this plugin runs on, as a semver range that should carry an upper
  bound (`>=5.0.0 <6.0.0`). Core itself only checks the range is non-empty and satisfied by the
  running version; the official catalogue's CI is what refuses an unbounded range before publishing.
  A prerelease core matches as its own release would, so a `5.0.0-rc` runs the
  plugins that declare `>=5.0.0` — which is how a major upgrade gets rehearsed before it ships.
- `files` — sha256 of every archive entry but the manifest and its own signature.
- `database` — `{ schema: boolean, coreRefs: string[] }`: whether it wants its own schema, and
  which core tables it needs `REFERENCES` on.
- `routes[]` — every route core will proxy, each with the CASL `policy` it requires and an
  optional `objectGuard`. A route that is not declared does not exist. (Not `provides.routes[]` —
  there is no `provides` key; `routes` sits at the manifest's top level.)
- `scopes[]` — the grants this plugin needs, consented once at install and enforced on every host
  call. Declare every scope the methods you call require, from this table:

  | Scope | Host methods it unlocks |
  |---|---|
  | `media:read` | `media.acquisitionContext`, `media.resolve`, `media.exists`, and — because both answer with media identity for the whole library — `acquisition.candidates` and `releases.match` |
  | `acquisition:candidates` | `acquisition.candidates`, `releases.match` |
  | `releases:score` | `releases.score` |
  | `ingest:write` | `library.ingest` |
  | `events:emit` | `events.publish`, `notifications.dispatch`, `events.emitOwn`, `counts.set`, `progress.set` |
  | `config:rw` | `config.get`, `config.set` |

  A method whose scopes you have not all declared rejects with `missing scope "<scope>" required
  for "<method>"`. The `call!` sites in `server/crates/server/src/plugins/imports.rs` are the
  source this table restates.
- `ingestRoots[]` — the allowlist `library.ingest` paths must fall under; may be empty.

Optional beyond that:

- `jobs[]` (`process`) — named cron entries core schedules and dispatches.
- `network` (`process`) — `{ internal: true }` and nothing else: lets the plugin's outbound requests
  reach private addresses (a LAN download client). The install consent sheet is the grant; an upgrade
  that newly asks for it is not applied unattended and waits for an admin to confirm, unless it
  replaces a `pluginApi` 1 package signed by the same key, which carries the grant over.
- `events[]` — domain events to receive. Only a `data` plugin uses it: it gets an HTTPS POST from core.
  A `process` plugin is called with every domain event and ignores the list.
- `permissions[]` (`process`) — raw names; core builds the CASL subject as `plugin:<id>:<name>`, so a plugin cannot claim another's or a core subject.
  Every distinct `action:subject` policy your `routes[]` declare is offered as its own tick box in the
  roles editor, so `read:plugin:<id>:queue` can be granted without `manage:plugin:<id>:queue`. A declared
  name no route names is offered whole (it then allows every action). Nothing is granted by default:
  until an admin ticks one, only admins pass the routes declared under it.
- `ui.*` — see below.
- `i18n` — every `labelKey` the plugin uses, per locale. Core merges them into the active language.

Unknown top-level keys are rejected, so a typo fails the install rather than being ignored.

## Contributing to the UI

A plugin ships **no** Angular. It declares data; core renders it.

**`ui.contributions[]`** puts an entry in one of six slots (`nav.main`, `nav.acquisition`,
`settings.page`, `media.actions`, `media.season.actions`, `card.actions`), with a weight, a
`labelKey`, an optional icon, and `when` predicates from a closed vocabulary — an unknown
predicate evaluates false, so a client that does not know a rule hides the entry rather than
guessing. The action is either a route or a **core-declared `actionId`**: core keeps a closed
catalogue per slot, and an id it does not know renders nothing.

A contribution whose route opens one of your own views (`/plugins/<id>/<pageId>`, or
`/admin/settings/plugins/<id>/<pageId>`) must name a page you declare in `ui.configPages[]`; anything
else is refused at registration. Core then serves `GET /plugins/ui` per viewer: a `providers` or
`table` page is sent only to a user whose ability satisfies the policy of the route it lists from,
and the contributions opening a withheld page are withheld with it. So a nav entry never needs a
`when` to restate its own route's policy; use `when` for what the policy cannot express.

**`ui.releasePicker`** names the routes of the release picker per kind of work and level: kinds are
`movie`, `series`, `book`, `comic`, `album`, levels `work` (the whole title), `group` (a
season) and `item` (an episode), each a `{search, grab}` pair of the plugin's own routes (`search` a
`GET`, `grab` a `POST`), at least one level per kind: `{ movie: { work: {...} }, series: { group: {...},
item: {...} } }`. The core picker fills `:id`, `:seasonId` and `:episodeId` in the routes. A kind the
server does not serve is accepted and ignored.

**`ui.configPages[]`** declares a page, discriminated on `kind`:

- `form` — key/value settings stored in `app_settings` under `plugin.<id>.<key>`, rendered by
  core's schema form. Works with the plugin stopped. May declare `actions[]` naming a
  core-implemented button.
- `providers` — a CRUD list of instances over the plugin's own routes, with a per-implementation
  field set, an optional connection test, and row/list actions.
- `table` — a read-only list over one route, with declared columns and row actions.

A `form` page's `fields[]` is an ordered list of items, discriminated on `kind`:

- a bare field (no `kind`, or `kind: 'field'`) — the input it has always rendered;
- `caption` — static text between fields, carrying a `textKey`; no input, no value;
- `group` — a labelled section of input fields. **One level only**: a group's own `fields` are
  plain input fields, never another group — nesting one is refused at install, not merely ignored;
- `status` — a read-only line naming a `settingKey`. It shows whatever value the plugin last wrote
  to `plugin.<id>.<settingKey>` via `config.set`. There is no route behind it, so — like the rest
  of `form` — it still renders with the plugin stopped; it is not a live status check.

A field may also declare validation constraints, all optional: `min`/`max` for a `number` field,
`minLength`/`maxLength` otherwise. The renderer enforces them before it will save. They are an
authoring affordance, not a trust boundary — the settings endpoint behind every `form` page is
already admin-gated. A blank `required` field is shown as a hint but does not block saving, because
clearing a value is how an operator unsets it.

There is deliberately no author-supplied regular expression. A pattern arriving from a manifest is
untrusted, a `providers` page's fields arrive over HTTP at render time and never pass the manifest
validator at all, and no syntactic check separates a safe expression from one that hangs the tab —
a measured `^(a|a)+$` takes over a second on 26 characters, while an ordinary IPv4 or hostname
pattern trips every heuristic that catches it.

Declaring a page does **not** link to it: a `settings.page` contribution is what puts it in the
admin sidebar.

If a page needs something these three cannot express, it is not a plugin page. The escape is a
core change adding a `kind`, not a plugin shipping code.

## Player pre-roll

**`ui.player`** declares one route, `{ preRollRoute: string }`, that must name a `POST` entry in
this manifest's own `routes[]` — the same rule `releasePicker` applies to its own routes. Only one
plugin's declaration is ever live: if more than one declares it, the lexicographically smallest
plugin id wins and the others are logged and ignored, exactly like `releasePicker`.

Before a `playback-info` response goes out, core POSTs `{ mediaFileId, mediaId, episodeId }` to the
winning plugin's route on behalf of the requesting user and expects back a JSON array of items
shaped `{ mediaFileId: number, labelKey?: string, skippable?: boolean }` — **`mediaFileId` only**;
there is no URL and no path in this contract. An item names a library file; it is not a pointer to
one, and core is the only party that ever turns it into something playable. The array is capped at
`PRE_ROLL_ITEMS_MAX` items; anything past the cap, not a positive integer `mediaFileId`, repeated,
or naming the item about to play anyway, is dropped — the last two would play one file twice.

Every id core gets back is still resolved and ACL-checked through the exact same path the main
item uses — a file in a library the requesting user cannot see, or one that no longer resolves, is
dropped silently. A plugin can only *name* a candidate; it can never grant access to one. If no
plugin declares `ui.player`, the plugin is not running, the call fails or times out, or it answers
anything other than 200 with that exact shape, `playback-info` simply omits `preRoll` from its
response — the feature is invisible on failure, never a broken playback-info call.

The Apple TV and Cast players do not model this field and will play the main video only.

## What a `process` plugin can ask of core

A `process` plugin is a WebAssembly component (`pluginApi` 3, world `fliks:plugin@3.0.0`) that
`fliks-server` runs in its own wasm host (wasmtime). It is built with the `fliks-plugin-sdk` crate
(`server/crates/plugin-sdk/`, `MIT OR Apache-2.0`, pinned by git rev, not published to a registry): the WIT, the `export!`
macro, typed `host`, `db`, `http` and scheduled-call helpers, an async runtime (`rt`: `block_on`,
`join_all`, `spawn_local`, `timeout`, `sleep` over `wstd`, and `Budget` with the per-export guest
budgets) so one export can have several outbound requests in flight, `info!`-style logging that
scrubs `scheme://user:pass@` (and `log::redact_url`), a router over the host's own route matcher
(`fliks-plugin-route`), a component test harness over the real host (feature `harness`) and the
build, package and verify tooling (feature `build`, `cargo xtask build|package|verify`). The host
rules are `server/docs/spec/plugins.md`. The UI-contribution types the web client reads live in
`client/src/app/core/plugin-ui/ui-contribution.ts`.

Start from the SDK's examples: `examples/fixture-guest/` exercises every host behaviour and is what
the host tests run, `examples/xtask/` is the build tool a plugin repository keeps.
`fk-plugin-download` and `fk-plugin-notify` are the reference implementations.

### The sandbox

There are no sockets, pid files or uids: the component only has what the host links in.

- **Network**: no sockets of its own. Outbound HTTP goes through `wasi:http`, and every request is
  vetted by the host: `http` and `https` only, the name resolved once and every address checked, no
  redirect followed for it. Private ranges are refused unless the manifest declares `network:
  {internal: true}` and an admin consented at install; reserved, multicast and link-local (cloud
  metadata) ranges stay refused either way. At most 32 requests per plugin are in flight.
- **Filesystem**: one directory, `/data`, private to the plugin and kept across restarts and
  upgrades. Uninstall keeps it unless the admin asks to delete the plugin's data. Nothing else is
  visible.
- **Database**: its own role and schema, through the `db` interface (see Database).
- **Memory and time**: `memoryMb` caps each instance's linear memory, and every export has a
  deadline (see Deadlines and ceilings). A trapped, out-of-memory or overdue instance is dropped;
  the host and the other plugins are unaffected.
- **Host functions**: a fixed set of calls — media lookup, acquisition targets, release scoring,
  library ingest constrained to declared `ingestRoots`, event publication, settings read/write
  scoped to the plugin's own `plugin.<id>.` namespace, scheduled calls — each bound to the
  calling plugin's id and checked against its declared `scopes`.

### Exports and lifecycle

The guest interface is `hello`, `health`, `start`, `http`, `event`, `config-changed`, `job`,
`scheduled` and `shutdown`. A guest holds no timer between calls and may be dropped at any time, so
nothing that matters lives in an instance: it lives in the plugin's schema, its `/data`, or a
scheduled call.

- **Instances**: a wasm instance runs one export at a time, so the host keeps lanes: one `core`
  instance (`hello`, `start`, `health`, `config-changed`, `shutdown`), one for `event`, up to four for
  proxied `http`, one per declared job, and up to two for `scheduled`. A health check, a request or an
  event never waits behind a job. Idle `http`, `job` and `scheduled` instances are dropped after
  10 minutes.
- **Handshake**: `hello(core-version, config)` gets the plugin's settings (keys without the
  `plugin.<id>.` prefix) and answers `{ id, version, plugin-api }`, which the SDK embeds at build time.
  The host compares them for exact equality with the signed manifest; a mismatch fails the
  registration as `manifest-mismatch`, with no retry.
- **Start**: `start` then runs once, after `hello`, whenever the plugin has no other live instance.
  It runs the migrations and re-arms the plugin's own background work; the plugin is `ready` once it
  returns. A `start` that errors is a crash, unless core's own database was unreachable, in which case
  the plugin is `degraded` and `start` is retried.
- **Health**: the `core` instance gets `health` every 15 s, reply `{ ok, detail? }`. Two consecutive
  `ok: false` replies mark the plugin `degraded` (503 on its routes, withdrawn from the UI), four
  drop the instance as a crash; a good reply recovers it. A health call that times out or traps is a
  crash at once.
- **Crashes**: a crash drops only that instance, and its lane re-creates one after `1, 2, 4, 8, 16,
  30 s` (the ladder resets after 120 s of continuous `ready`). Six crashes in ten minutes trip the
  breaker.
- **Config changes**: when an admin saves one of the plugin's own settings, every live instance gets
  `config-changed(keys)` before its next call. It names the keys, not the values; call `config.get`.
- **Events**: every domain event is delivered to every `process` plugin as `event(name, payload)`,
  unfiltered, at-most-once, through a ring of 64 per plugin (the oldest is dropped when it is full). A
  plugin's own `events[]` is ignored.
- **Jobs and scheduled calls**: `jobs[]` are cron entries core runs as `job` calls, with no overlap
  per job. `schedule-call(key, delay-ms, payload)` stores one durable pending call per key in a
  host table, so it survives restarts, disable and upgrade. It runs as `scheduled(key, payload,
  attempt)`; delivery is at-least-once, so the handler must be idempotent. After 20 attempts the call is dropped.
- **Logs**: `log` and every line written to stdout or stderr go to core's log ring under the context
  `plugin:<id>`.

## Database

A `process` plugin that asks for a schema gets its own Postgres role
(`fp_<database oid>_<id with dots as underscores>`) and schema (`plugin_<id with dots as
underscores>`), a password rotated on every start and never handed to the
guest, and `REFERENCES`-only grants on the core tables it declared. It reaches them only through the
`db` interface (`query`, `execute`, `migrate`): the host keeps one pool per plugin, logged in as that
role with the schema as its whole `search_path`. A plugin runs its own migrations, from `start`.
Core never reads those tables.

Uninstalling with `deleteData` drops the role and the schema. A plain uninstall keeps the schema
and its rows, and the role stops logging in. Disabling touches neither.

### Export and import

`GET /api/plugins/:id/export` returns one JSON document: the plugin id, its installed version,
every `plugin.<id>.*` setting, and every row of every table in the plugin's own schema (`data`
plugins have no schema, so `tables` is empty). Column and table names are read from the database
catalogue on every call, never trusted from anywhere else, and the schema queried is always
`plugin_<id>` — never `public` and never another plugin's schema.

**A table whose name begins with an underscore is yours, and core leaves it alone.** It is never
exported, never written back, and never counted when deciding whether a schema is empty. That is
what a migration ledger like `_migrations` is: it records which migrations have run, so restoring an
older copy of it over a freshly-migrated schema would misstate the schema's own version.

**Secrets are masked by default.** Settings and table columns the manifest declares secret are left
out, and `maskedSettings` lists the masked keys; importing a masked export never touches an absent
key, so the current secrets stay. `?includeSecrets=true` exports them too and needs Manage on
Settings instead of Read: that document is a credential dump, handle it like one.

`POST /api/plugins/:id/import` restores that document, and refuses rather than merges:

- **Version mismatch** (`PLUGIN_EXPORT_VERSION_MISMATCH`, 409): the export's `pluginVersion` must
  equal the installed version. There is no migration-diff engine here — a plugin's schema and its
  setting keys are shaped by its own migrations, so replaying an old export onto a newer (or
  older) version risks writing rows or keys that no longer match. Install the matching version
  first.
- **Schema already has rows** (`PLUGIN_SCHEMA_NOT_EMPTY`, 409): import refuses if any table in the
  plugin's schema already holds a row, bookkeeping tables aside — a plugin that has merely migrated
  counts as empty, which is the state a restore is meant for. A silent merge into a half-populated schema would look like
  a complete restore without being one; uninstall the plugin with `deleteData` and reinstall it
  before importing.
- **Not yet activated** (`PLUGIN_NOT_READY`, 409): the installed plugin's last activation must have
  succeeded, since that's what proves its own migrations have run.

A restore writes rows carrying their original ids, so every serial column's sequence is moved past
the highest restored value in the same transaction. Without that the plugin's first insert after an
apparently successful import fails on a duplicate key.

Both routes are admin-only, gated the same way as the rest of `/plugins`.

## Events

`events[]` names domain events. For a `data` plugin, `webhook` is either an absolute https URL or
`setting:<key>` naming a field the plugin declares on a `form` page — the operator's own endpoint,
read at delivery. Either way core checks https, refuses an internal address, and re-resolves DNS on
every attempt, because a name that passed at install can be repointed afterwards. Delivery is
at-most-once with no retry; a plugin that needs retries is `process` and does its own.

## Metrics

`GET /plugins/metrics` (admin-gated the same way as the rest of `/plugins`) answers one entry per
installed plugin: `{ pluginId, kind, metrics }`. `metrics` is `null` for a `data` plugin — it has no
instances — and for a `process` plugin that isn't currently running: never a row of zeros that
reads like a healthy plugin. For a running `process` plugin, summed over its instances, it carries:

- `hostCallCount` / `hostCallFailureCount` — every call the guest makes to the `host` interface;
  `db` and `log` calls are not counted.
- `hostCallP95Ms` — p95 duration over the most recent 256 host calls, not a time window, so a
  plugin that has been up for weeks still reports a bounded, recent figure. `null` before the first call.
- `restartCount` — crashes since this plugin was registered.
- `eventDropCount` — events core could not deliver because the plugin's ring of 64 was full.
- `residentSetSizeBytes` — the linear memory in use across the instances, read when the endpoint is
  called. `null`, never `0`, when no instance is up.

## Trust and installation

An archive is a ZIP with a closed set of legal entry names, size caps, and an Ed25519 signature
over the manifest. Install is two steps: `inspect` verifies and stages, `confirm` promotes what was
staged, and the consent sheet in between is the only place an unverified plugin is accepted.

Signature outcomes are `official` (a catalogue release key), `unverified`, or `unsigned`. Only the
catalogue key verifies: there is no registry of third-party signing keys, so an archive signed by
anyone else is `unverified` and reaches an operator behind the consent sheet's acknowledgement. A
`process` plugin must be `official` (`PLUGIN_UNSIGNED` otherwise) unless the admin setting
`plugins.allow_unsigned` is on, which exists for local development only. The setting gates installs, not loads: switching it back off
leaves an unsigned plugin already installed running, uninstall it instead.

### Packaging

`cargo xtask package <plugin dir>` (the SDK's `build` feature) builds the release component for
`wasm32-wasip2`, writes `plugin.json` from `plugin.template.json` with the version and every
`files` sha256, and writes a deterministic store-only archive the host's inspector accepts;
`verify` runs that inspector, the size budget and the world check. An unsigned archive installs
only when `plugins.allow_unsigned` is on; `--key <hex seed file>` adds a dev signature.

A `process` archive carries `plugin.json`, `plugin.wasm` (starting with the component preamble), the
logo and the signature; `plugin.wasm` is capped at 32 MiB and the uncompressed entries at 48 MiB in
all. There is no `installed/` tree: the host hashes the archive it stored at every load and compiles
the component from it (the compiled form is cached and authenticated against the database row).

### Deadlines and ceilings

Core enforces these; exceeding one gets your call abandoned and, for a call on an instance, the
instance dropped. The values are `server/docs/spec/plugins.md` rules 39-43 and the host's
`Deadlines`; a guest reads the budget of the export it runs in with `deadline-remaining-ms`.

| What | Value | On breach |
|---|---|---|
| `hello` | 10 s | crash, restarted with backoff |
| `start` | 15 min | crash, restarted with backoff |
| `health` | 10 s, asked every 15 s | a timeout is a crash; 2 `ok: false` replies degrade, 4 recycle |
| `config-changed` | none of its own | runs inside the deadline of the call it precedes |
| `shutdown` | 3 s | instance dropped |
| proxied `http` | 180 s | 504, instance dropped |
| pre-roll | 3 s, queue included | the item list is omitted |
| `event` | 60 s | instance dropped |
| `scheduled` | 5 min | instance dropped, the call fires again |
| `job` | 60 min | instance dropped |
| host call | 8 s | `ERR_TIMEOUT`; `library.ingest` 30 min, `db.migrate` 10 min |
| `db.query` / `db.execute` | 60 s | cancelled, SQLSTATE `57014` |
| outbound HTTP requests in flight | 32 per plugin | the 33rd waits for a slot, inside the call's deadline |
| proxied requests waiting for an instance | queue of 32, 30 s | 503 `PLUGIN_UNAVAILABLE` |
| stdout, stderr and `log` | 64 KiB/min | output dropped for the rest of the minute, once with a warning |
| memory (`memoryMb`) | at most 1024, per instance | `memory.grow` past it traps that instance |

Guest CPU is bounded by the wall-clock deadline, enforced by epoch interruption. Six crashes in ten
minutes trip the breaker: the plugin is `failed` until an admin restarts or re-enables it.

Catalogue sources are HTTPS documents listing each plugin's installable versions with a `sha256`
per version; core refuses bytes whose hash does not match. Publishing a plugin means committing its
built source into the catalogue repository, adding a version entry, and running its packaging
workflow, which signs with the catalogue key and records the published archive's hash.

## Revocation

A catalogue document may also carry a `denyList`: entries of `{ pluginId, version?, sha256?, reason }`.
Omitting `version` denies every version of `pluginId`; adding `sha256` narrows an entry to one exact
build rather than every archive ever published under that version string. A malformed entry is
dropped rather than failing the whole (already signature-verified) refresh.

**Revocation authority is signing authority.** An entry only revokes a package whose
`verifiedByKeyId` equals the key id that verified the deny-list's own catalogue document. A
catalogue signed by the compiled-in release key revokes anything that key signed; a source with its
own pinned key revokes only what *that* key signed — nothing, today, since no plugin ships signed by
a source key yet; and an unsigned or manually-imported package (`verifiedByKeyId: null`) is
revocable by nobody, because nobody vouched for it in the first place. This falls out of the
existing trust model with no migration and no new authority to reason about: a catalogue's key is
already the thing an operator chose to trust when they added the source.

A denied version cannot be installed — refused with `PLUGIN_DENIED` (403), carrying the publisher's
`reason` — and cannot register, at boot or on hot-reload, with its own `revoked` failure reason.
Like `untrusted`, `revoked` is **not** treated as "installed but not running": its routes are torn
down rather than left answering 503, because a revocation withdraws the authority to run at all —
it is not reporting an outage.

Latency: a revocation reaches an already-running plugin the moment the catalogue that names it
refreshes — the daily 3am cron, or immediately on a manual refresh — never waiting for a reboot. The
refresh that lands a new deny-list entry stops any matching installed package and marks
its row `failed` with the publisher's reason right there, rather than merely blocking the next
install.

## Operator semantics worth knowing before you rely on them

- **Disable** stops the plugin's instances and drops every live registration — routes, contributions,
  jobs, webhooks — while the row, the archive, the role, the schema and its pending scheduled calls
  stand.
- **Uninstall** removes its pending scheduled calls, its `plugin.<id>.*` settings and its
  registration. The schema, its rows and the data directory stay unless `deleteData` is set.
- **An upgrade over a disabled plugin stays disabled.**
- A plugin that is not `ready` has its contributions filtered out server-side, so a frozen client
  never has to know about plugin health.

---

## Proposing an extension point

Everything a plugin can reach is a closed set: the host functions in the WIT world
(`server/crates/plugin-sdk/wit/fliks.wit`), the scopes in `server/crates/server/src/plugins/manifest.rs`,
the UI slots in `client/src/app/core/plugin-ui/ui-contribution.ts`, and the routes a manifest may
declare. That is deliberate — a closed set is what makes a plugin's blast radius reviewable, and what
lets core promise a plugin will keep working across a release.

It also means "can my plugin do X?" has no answer a plugin author can reach alone. When X is not in
one of those sets, open an issue. A proposal that can be acted on says:

1. **What the plugin is trying to do**, in terms of the user-visible outcome — not the API you
   imagined for it. The right extension point is frequently not the one proposed.
2. **What you tried within the existing set**, and where it stopped. Often the answer is an existing
   function used differently, and that is a faster outcome for everyone than a new one.
3. **What core would have to trust you with.** A new host function is a new scope, or a widening of
   one; say which, and what a hostile plugin holding it could do.
4. **Whether it can avoid a break.** The host links one WIT package version per `pluginApi`, so any
   change to a record or a function, an added field included, is a `pluginApi` bump that orphans every
   plugin that has not republished, and waits for a scheduled break. The enum `family`
   lists every case the roadmap foresees and `kind` is a string, for that reason.

Items 3 and 4 are what decide the answer. A proposal whose worst case is bounded and that rides a
scheduled break is a small change; one that widens an existing scope is a security review.

There is no transition window: core accepts only the `pluginApi` values it lists (today `3`), and a
plugin declaring another one is installed but `failed`, not loaded. Proposals that fit inside the
current value ship far sooner than proposals that need a new one.

## pluginApi 1 (Fliks 4.x)

Fliks 4.x ran `process` plugins as Node child processes (`runtime: "node"`, a `plugin.js`, JSON-RPC
over unix sockets). That contract is gone: a `pluginApi` 1 package, `data` tier included, still shows
up after an upgrade but is `failed` with `incompatible-api` and its routes answer 503, until the
catalog's auto-update installs a `pluginApi` 3 version of it. To port one, rebuild it against the SDK
and republish; the catalog's `COMPATIBILITY.md` has the `pluginApi` to Fliks version row.
