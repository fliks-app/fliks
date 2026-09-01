# Fliks plugin scaffold

A `process` plugin that starts, answers all 7 methods core calls, serves one route and reads its
own settings. MIT — copy it out and change the id.

## The one thing that decides your build

**An archive may contain only `plugin.json`, `plugin.js`, `logo.svg`/`logo.png` and
`plugin.json.sig`.** There is no `node_modules` in a plugin, so `plugin.js` has to be a bundle.
This scaffold uses esbuild; any bundler works. A plugin that `require`s a package at runtime dies
at spawn with `MODULE_NOT_FOUND` and shows up as `spawn-failed`.

The same rule decides how to import the contract:

```ts
import type { PluginApi, PluginManifest } from '@fliks/plugin-contract';        // types: free
import { MAX_FRAME_BYTES } from '@fliks/plugin-contract/protocol';              // values: leaf only
```

Types are erased, so the barrel is fine for them. For *values*, import the leaf — the barrel also
re-exports the one helper that needs `semver`, and pulling it in takes the bundle from 4 KB to
72 KB for constants you could have inlined.

## Dev loop

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run package          # bundle → dist/, then core's packaging tool → scaffold.fkplugin
```

Then install `scaffold.fkplugin` through **Settings → Plugins → Import**. Unsigned archives are
refused unless *Allow unsigned plugins* is on in **Settings → Plugins → Settings**.

Reinstalling the same id replaces the running plugin; there is no need to uninstall first.

## What is in here

| File | |
|---|---|
| `plugin.json` | The manifest. `files` is left empty — the packaging tool computes every hash, and a hand-written one is refused. |
| `src/plugin.ts` | Line framing, the uplink, and the 7 methods. About 100 lines. |

Both sockets are **dialled**, not listened on: core listens on both and the plugin connects to each.

`hello` must echo `FLIKS_PLUGIN_TOKEN` back. A wrong token is treated as an impostor on the socket
and the process is killed immediately.

`event` and `config` are notes — they carry no `i` and core accepts no reply for them. Every other
method must answer within the deadline core publishes in `PLUGIN_DEADLINES_MS`.

## Things the manifest will reject

Core answers with a `reason` and a `detail` naming the field, visible on the plugin row:

- `scopes` must come from the closed set (`media:read`, `acquisition:candidates`, `releases:score`,
  `requests:progress`, `ingest:write`, `events:emit`, `config:rw`) and may not be empty.
- A route `policy` is `action:subject`, in that order — `read:Settings`, not `Settings:read`.
- `i18n` keys must share a single root, and no key may be a prefix of another.
- `fliks` needs an upper bound: `">=3.0.0 <4.0.0"`, never `">=3.0.0"`. Bump it when a new Fliks major ships and the plugin has been checked against it.

## Logging and failure

Write to stderr. Core tags each line with your plugin id, buffers it, and shows the tail on the
plugin row when the process is down — so a stack trace at startup is visible in the admin UI
without touching container logs. The cap is 64 KB/min; past that, lines are dropped.
