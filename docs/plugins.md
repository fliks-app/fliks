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

One `plugin.json` at the archive root, validated before anything is written. Beyond identity
(`id`, `version`, `pluginApi`, `fliks` range with a mandatory upper bound, `author`, `license`,
`logo`):

- `kind` — `data` or `process`, read from inside the signed manifest.
- `provides.routes[]` (`process`) — every route core will proxy, each with the CASL `policy` it
  requires and an optional `objectGuard`. A route that is not declared does not exist.
- `database` (`process`) — whether it wants its own schema, and which core tables it needs
  `REFERENCES` on.
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

Declaring a page does **not** link to it: a `settings.page` contribution is what puts it in the
admin sidebar.

If a page needs something these three cannot express, it is not a plugin page. The escape is a
core change adding a `kind`, not a plugin shipping code.

## What a `process` plugin can ask of core

A spawned plugin talks to core over two unix sockets with newline-delimited JSON-RPC: one for the
calls it makes, one for the notes core sends it (`hello`, `health`, `event`, `config`, `http`,
`job`, `shutdown`). Its host API is a fixed set of methods — media lookup, acquisition targets,
release scoring, library ingest constrained to declared `ingestRoots`, event publication with a
forced `<pluginId>.` prefix, settings read/write scoped to its own namespace.

The contract types live in `backend/src/common/plugin-contract/` and are **restated** in each
plugin repository, because a spawned plugin cannot import from core at runtime. Two guards keep
the copies honest: a CI job diffs the client mirror against the backend's, and each plugin repo
runs a drift checker against a sibling checkout. Compare **declarations, not just names** — a
field that matches by name and differs by type compiles and misbehaves.

## Database

A `process` plugin that asks for a schema gets its own Postgres role and schema
(`plugin_<id with dots as underscores>`), a password rotated on every spawn, and `REFERENCES`-only
grants on the core tables it declared. It runs its own migrations. Core never reads those tables.

Uninstalling drops the role and the schema. Disabling does not.

## Events

`events[]` names domain events. For a `data` plugin, `webhook` is either an absolute https URL or
`setting:<key>` naming a field the plugin declares on a `form` page — the operator's own endpoint,
read at delivery. Either way core checks https, refuses an internal address, and re-resolves DNS on
every attempt, because a name that passed at install can be repointed afterwards. Delivery is
at-most-once with no retry; a plugin that needs retries is `process` and does its own.

## Trust and installation

An archive is a ZIP with a closed set of legal entry names, size caps, and an Ed25519 signature
over the manifest. Install is two steps: `inspect` verifies and stages, `confirm` promotes what was
staged, and the consent sheet in between is the only place an unverified plugin is accepted.

Signature outcomes are `official` (a catalogue release key), `verified`, `unverified`, or
`unsigned`. A `process` plugin must be signed unless its id is in `FLIKS_UNSIGNED_PLUGINS`, which
exists for local development only.

Catalogue sources are HTTPS documents listing each plugin's installable versions with a `sha256`
per version; core refuses bytes whose hash does not match. Publishing a plugin means committing its
built source into the catalogue repository, adding a version entry, and running its packaging
workflow, which signs with the catalogue key and records the published archive's hash.

## Operator semantics worth knowing before you rely on them

- **Disable** stops the process and drops every live registration — routes, contributions, jobs,
  webhooks — while the row, the archive, the role and the schema stand.
- **Uninstall** destroys the schema and its data.
- **An upgrade over a disabled plugin stays disabled.**
- A plugin that goes unreachable has its contributions filtered out server-side, so a frozen
  client never has to know about plugin health.
