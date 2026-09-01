# Plugins

How the plugin system works, for whoever writes a plugin or changes core's side of it. What a
particular plugin *does* belongs in that plugin's own README.

## Two tiers

**`data`** ships JSON and executes nothing. It can contribute pages and menu entries, declare
settings, and subscribe to domain events — core makes every outbound request on its behalf. It
holds no database, answers no route, and runs no code. Installing one cannot execute anything.

**`process`** ships a `plugin.js` that core spawns as a child process. It answers HTTP routes
through core's proxy, owns a Postgres schema, and runs jobs on a schedule. It is the tier that can
do work of its own, and the one whose failure needs supervision.

Pick `data` unless the plugin genuinely needs to act. The tiers are not a spectrum: a `data`
plugin that needs to answer one route is a `process` plugin.

## The manifest

One `plugin.json` at the archive root, validated before anything is written. Every manifest,
`data` or `process`, must carry all of: `id`, `pluginApi`, `name`, `version`, `fliks` (a semver
range with a mandatory upper bound, e.g. `">=2.1.0 <3.0.0"`), `author`, `description`, `license`,
`logo`, and `kind` (`data` or `process`) — the install fails if any one is missing. `homepage` is
the only identity field that's optional.

A `process` manifest additionally requires these seven keys — reference `fk-plugin-download`'s
`plugin.json` for a manifest that satisfies all of them:

- `runtime` — the only legal value is the literal `"node"`.
- `memoryMb` — passed through as the child's own `--max-old-space-size`. Core does not clamp it.
- `pluginApi` — the contract revision this plugin is written against. Core accepts every value in
  its own `SUPPORTED_PLUGIN_API_VERSIONS`, so a bump does not orphan your plugin the day it lands:
  the older value keeps working until a later release drops it, and that window is when to republish.
- `fliks` — the core versions this plugin runs on, as a semver range with a mandatory upper bound
  (`>=3.0.0 <4.0.0`). A prerelease core matches as its own release would, so a `3.0.0-rc` runs the
  plugins that declare `>=3.0.0` — which is how a major upgrade gets rehearsed before it ships.
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
  | `requests:progress` | `requests.markInProgress` |
  | `ingest:write` | `library.ingest` |
  | `events:emit` | `events.publish`, `notifications.dispatch`, `events.emitOwn`, `counts.set`, `progress.set` |
  | `config:rw` | `config.get`, `config.set` |

  A method whose scopes you have not all declared rejects with `missing scope "<scope>" required
  for "<method>"`. `HOST_METHOD_SCOPES` in the contract is the source this table restates.
- `ingestRoots[]` — the allowlist `library.ingest` paths must fall under; may be empty.

Optional beyond that:

- `jobs[]` (`process`) — named cron entries core schedules and dispatches.
- `events[]` — domain events to receive. A `data` plugin gets an HTTPS POST from core; a `process`
  plugin gets a note over its socket.
- `permissions[]` — raw names; core builds the CASL subject as `plugin:<id>:<name>`, so a plugin cannot claim another's or a core subject.
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

**`ui.configPages[]`** declares a page, discriminated on `kind`:

- `form` — key/value settings stored in `app_settings` under `plugin.<id>.<key>`, rendered by
  core's schema form. Works with the process stopped. May declare `actions[]` naming a
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
  of `form` — it still renders with the process stopped; it is not a live status check.

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

A spawned plugin talks to core over two unix sockets with newline-delimited JSON-RPC: one for the
calls it makes, one for the notes core sends it (`hello`, `health`, `event`, `config`, `http`,
`job`, `shutdown`). Its host API is a fixed set of methods — media lookup, acquisition targets,
release scoring, library ingest constrained to declared `ingestRoots`, event publication with a
forced `<pluginId>.` prefix, settings read/write scoped to its own namespace.

The contract types are the `@fliks/plugin-contract` package, whose source is
`backend/src/common/plugin-contract/`. Depend on it rather than restating it — the types are
erased at build time, so a spawned plugin still ships no core code and still cannot import from
core at runtime. Three entry points: the barrel for the whole surface, `/protocol` for wire
constants and `/ui` for the UI-contribution types, the last two dependency-free.

It is deliberately **not** on any registry: compile-time-only types need no publishing step, and
none of this repository depends on one. Each GitHub release carries the package as an installable
tarball stamped with that release's version (`.github/workflows/plugin-contract-asset.yml`), and an
author who already keeps a core checkout beside their plugin can point `paths` at it instead. The
package README states both.

The client consumes the same files through a tsconfig path mapping, so there is one declaration of
each type in the tree and nothing to keep in sync. That mapping points one level above `client/`, so
anything that builds the client in a container has to bring the directory along — the image build
copies it, and a dev container bind-mounting only `client/` needs the same:

```yaml
volumes:
  - ./client:/app
  - ./backend/src/common/plugin-contract:/backend/src/common/plugin-contract:ro
```

Without it the build stops at `TS2307: Cannot find module '@fliks/plugin-contract/ui'`.

`examples/plugin-scaffold/` is the starting point: a `process` plugin that starts, answers all 7
methods, serves a route and reads its own settings, under MIT. Its README carries the dev loop and
the mistakes core refuses by name. `fk-plugin-download` is the full reference implementation.

A `process` plugin ships as **one bundled `plugin.js`** — an archive carries no `node_modules`, so
an unbundled `require` of any package, this one included, fails at spawn with `MODULE_NOT_FOUND`.

### Environment

Core never passes `...process.env` to the child — everything a `process` plugin gets is one of
these, set once at spawn (`supervisor/spawn-plan.ts`):

- `FLIKS_PLUGIN_TOKEN` — random per spawn. Echo it back, unmodified, as `hello`'s `token`: it is
  the only proof the responder is the process core just spawned, not something else connected to
  the same socket. Get this wrong and the plugin is SIGKILLed with no message naming why.
- `FLIKS_CORE_SOCK` — the unix socket to dial for this plugin's own host-API calls.
- `FLIKS_PLUGIN_SOCK` — the unix socket to listen on for core's calls.
- `FLIKS_DB_URL` — this plugin's own Postgres connection string; empty when its manifest declared
  no schema.
- `FLIKS_PLUGIN_ID` — this manifest's `id`, verbatim.
- `FLIKS_API_VERSION` — the plugin API version, stringified. Checked for exact equality, never a
  range.
- `FLIKS_CFG_*` — every `plugin.<id>.<key>` admin setting, re-keyed: drop the `plugin.<id>.`
  prefix, upper-case what's left, replace every character outside `[A-Z0-9_]` with `_`, and
  prepend `FLIKS_CFG_`. Not a fixed set — read whichever names your own manifest's settings
  resolve to.

### Filesystem

`--allow-fs-read` covers this plugin's own code directory; `--allow-fs-write`, `HOME` and the
child's cwd are all one directory keyed by this plugin's `id` alone, outside that code tree.
That split matters because the code directory does not survive: core re-extracts and replaces it
from the signed archive on every ordinary start — boot, enable, an admin restart, install and
upgrade alike, not just a crash respawn — so nothing written there outlives the next start. The
data directory is never touched by that sweep, so it is the only place worth writing anything a
restart, an upgrade, or a disable/re-enable needs to survive. Uninstall removes the code directory
and (for a schema-owning plugin) the database schema; the data directory is not part of either.

### The handshake

The first call core makes on a freshly spawned child is `hello`, with `{ pluginApi, coreVersion,
config }`. That `pluginApi` — and the `FLIKS_API_VERSION` env var — is the value **your** manifest
declares, not core's newest: core answers each plugin in the revision that plugin was written
against, so comparing it for exact equality against the revision you built for is safe. The reply must be `{ manifest, token }`: `manifest` is this archive's own
`plugin.json`, read fresh rather than baked into the bundle, and `token` is `FLIKS_PLUGIN_TOKEN`
echoed back exactly. A wrong or missing token is a crash: core logs `plugin crashed: hello token
mismatch` against that plugin's own log stream and retries up the backoff ladder until the breaker
trips. See `fk-plugin-download`'s `hello` handler in `src/plugin.ts` for a minimal implementation
that gets both right.

### Health

Once ready, core calls `health` on `healthIntervalMs` (15s default) with no payload; reply with
`{ ok: boolean, detail?: string }`. A reply of `ok: false` counts exactly like a timed-out or
unanswered call — two consecutive misses mark the plugin `degraded`, four force a SIGTERM-then-
SIGKILL respawn — so an unhealthy-but-reachable plugin can ask to be recycled without waiting out
the deadline. `detail` is logged against this plugin's own log stream, so name what's wrong there.

### Config changes

When an admin saves one of this plugin's own `plugin.<id>.*` settings while it is running, core
pushes a `config` note: `{ changed: string[] }`, one entry, the same unprefixed key shape
`config.get` returns. It names what changed; it does not carry the new value — call `config.get`
for that. A plugin that is not running is never a target, and a save for a namespace no running
plugin owns raises nothing.

## Database

A `process` plugin that asks for a schema gets its own Postgres role and schema
(`plugin_<id with dots as underscores>`), a password rotated on every spawn, and `REFERENCES`-only
grants on the core tables it declared. It runs its own migrations. Core never reads those tables.

Uninstalling drops the role and the schema. Disabling does not.

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

**This document is a credential-bearing artifact.** It contains whatever the plugin stored,
including anything an operator typed into a `secret` field on a config page. Nothing is stripped
or masked — a partial export that looks complete is worse than one that's honest about carrying
secrets. Handle it like any other credential dump.

`POST /api/plugins/:id/import` restores that document, and refuses rather than merges:

- **Version mismatch** (`PLUGIN_EXPORT_VERSION_MISMATCH`, 409): the export's `pluginVersion` must
  equal the installed version. There is no migration-diff engine here — a plugin's schema and its
  setting keys are shaped by its own migrations, so replaying an old export onto a newer (or
  older) version risks writing rows or keys that no longer match. Install the matching version
  first.
- **Schema already has rows** (`PLUGIN_SCHEMA_NOT_EMPTY`, 409): import refuses if any table in the
  plugin's schema already holds a row, bookkeeping tables aside — a plugin that has merely migrated
  counts as empty, which is the state a restore is meant for. A silent merge into a half-populated schema would look like
  a complete restore without being one; uninstall and reinstall the plugin (which wipes its
  schema) before importing.
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
supervisor — and for a `process` plugin that isn't currently running: never a row of zeros that
reads like a healthy process. For a running `process` plugin it carries:

- `hostCallCount` / `hostCallFailureCount` — every inbound call across the plugin's 15 host
  methods, counted once in `dispatchHostCall`, the single funnel all of them share.
- `hostCallP95Ms` — p95 duration over the most recent 256 host calls, not a time window, so a
  plugin that has been up for weeks still reports a bounded, recent figure. `null` before the first call.
- `restartCount` — crash-triggered respawns since this plugin's supervisor last started.
- `eventDropCount` — notes core could not deliver because the outbound ring to this plugin was full.
- `residentSetSizeBytes` — the child's resident memory, read from `/proc/<pid>/statm` when the
  endpoint is called, not polled in the background. `null`, never `0`, off Linux or if the child
  isn't up — a gauge that always silently reads zero is worse than one that admits it can't answer.

## Trust and installation

An archive is a ZIP with a closed set of legal entry names, size caps, and an Ed25519 signature
over the manifest. Install is two steps: `inspect` verifies and stages, `confirm` promotes what was
staged, and the consent sheet in between is the only place an unverified plugin is accepted.

Signature outcomes are `official` (a catalogue release key), `unverified`, or `unsigned`. Only the
catalogue key verifies: there is no registry of third-party signing keys, so an archive signed by
anyone else is `unverified` and reaches an operator behind the consent sheet's acknowledgement. A
`process` plugin must be signed unless the admin setting `plugins.allow_unsigned` is on, which
exists for local development only. The setting gates installs, not loads: switching it back off
leaves an unsigned plugin already installed running, uninstall it instead.

### Packaging

`npm run package-plugin -- <built-plugin-dir> [-o out.fkplugin]` (from `backend/`) turns a build
output directory — `plugin.json`, `plugin.js` for a `process` plugin, an optional `logo.svg` or
`logo.png` — into an archive the inspector above will accept. It recomputes every `files` sha256
itself rather than trusting the manifest, and refuses early, by name, on anything the inspector
would refuse later: a missing `plugin.js` for a `process` manifest, a `plugin.js` present on a
`data` one, a `logo` field that doesn't match what's on disk or whose bytes are not the format its
name claims, a bad id or version, an oversized entry, and any file an archive may not carry (rather
than dropping it silently and leaving you to find out at runtime). The archive it writes is always unsigned; a `process` plugin built this way installs only
when the installing core has `plugins.allow_unsigned` on. Signing an archive for real
distribution is a separate, later step this tool does not perform.

### Deadlines and ceilings

Core enforces these; exceeding one gets your call abandoned or your process killed. They are
exported from the contract as `PLUGIN_DEADLINES_MS`, `HOST_CALL_DEADLINE_OVERRIDES_MS`,
`PLUGIN_LOG_CAP_BYTES_PER_MINUTE`, `PLUGIN_DEFAULT_MEMORY_MB` and `MAX_FRAME_BYTES`, and a test
fails if they ever stop matching what the supervisor applies.

| What | Value | On breach |
|---|---|---|
| `hello` reply | 10 s | killed, restarted with backoff |
| `health` reply | 3 s, asked every 15 s | 2 misses degrade, 4 recycle |
| host call | 8 s | the call rejects; `library.ingest` is allowed 30 min |
| `shutdown` reply | 3 s, then 2 s before SIGKILL | killed |
| stdout+stderr | 64 KB/min | output dropped for the rest of the minute, once with a warning |
| heap (`memoryMb`) | 256 MB default | V8 old space only — nothing caps process RSS |
| one frame | 4 MiB | refused at the sender rather than breaking the connection |

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
refreshes — the daily 4am cron, or immediately on a manual refresh — never waiting for a reboot. The
refresh that lands a new deny-list entry stops any matching installed package's process and marks
its row `failed` with the publisher's reason right there, rather than merely blocking the next
install.

## Operator semantics worth knowing before you rely on them

- **Disable** stops the process and drops every live registration — routes, contributions, jobs,
  webhooks — while the row, the archive, the role and the schema stand.
- **Uninstall** destroys the schema and its data.
- **An upgrade over a disabled plugin stays disabled.**
- A plugin that goes unreachable has its contributions filtered out server-side, so a frozen
  client never has to know about plugin health.

---

## Proposing an extension point

Everything a plugin can reach is a closed set: the host methods in `host-methods.ts`, the scopes in
`manifest.ts`, the UI slots in `ui-contribution.ts`, and the routes a manifest may declare. That is
deliberate — a closed set is what makes a plugin's blast radius reviewable, and what lets core
promise a plugin will keep working across a release.

It also means "can my plugin do X?" has no answer a plugin author can reach alone. When X is not in
one of those sets, open an issue. A proposal that can be acted on says:

1. **What the plugin is trying to do**, in terms of the user-visible outcome — not the API you
   imagined for it. The right extension point is frequently not the one proposed.
2. **What you tried within the existing set**, and where it stopped. Often the answer is an existing
   method used differently, and that is a faster outcome for everyone than a new one.
3. **What core would have to trust you with.** A new host method is a new scope, or a widening of
   one; say which, and what a hostile plugin holding it could do.
4. **Whether it can be additive.** A new method, scope or slot is additive and can ship in a minor.
   A change to an existing one's shape or meaning is a `pluginApi` major and orphans every plugin
   that has not republished, so it waits for a scheduled break.

Items 3 and 4 are what decide the answer. A proposal that is additive and whose worst case is
bounded is a small change; one that widens an existing scope is a security review.

`SUPPORTED_PLUGIN_API_VERSIONS` is what a break costs in practice: a bump adds an entry, a later
release drops the oldest, and the window between the two is when authors republish. Proposals that
fit inside the current entry ship far sooner than proposals that need a new one.
