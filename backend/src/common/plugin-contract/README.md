# @fliks/plugin-contract

Type definitions and protocol constants for Fliks plugins. Types and constants only — no runtime
wiring, no core code. Everything here is erased at build time, so depending on it puts nothing of
core inside your plugin.

Not published to any registry, and it does not need to be: you need these at compile time only and
never ship them. Two ways to get them.

**The tarball attached to each release.** Pinned to the core version that produced it, so the number
means something:

```bash
npm i -D https://github.com/fliks-app/fliks/releases/download/v3.0.0/fliks-plugin-contract-3.0.0.tgz
```

**A path mapping onto a checkout**, if you already keep the core repo beside your plugin:

```json
{ "compilerOptions": { "paths": {
  "@fliks/plugin-contract": ["../fliks/backend/src/common/plugin-contract/index.ts"],
  "@fliks/plugin-contract/*": ["../fliks/backend/src/common/plugin-contract/*.ts"]
} } }
```

## Entry points

```ts
// Types — erased at build time, so the barrel costs nothing.
import type { ProcessPluginManifest, PluginApi } from '@fliks/plugin-contract';

// Runtime values — import the leaf.
import { MAX_FRAME_BYTES, PLUGIN_DEADLINES_MS } from '@fliks/plugin-contract/protocol';

// UI contributions alone. No dependencies, safe in a browser bundle.
import type { ConfigPage, UiContribution } from '@fliks/plugin-contract/ui';
```

| Specifier | |
|---|---|
| `@fliks/plugin-contract` | Everything: manifest, both method tables, principal, protocol, UI. |
| `@fliks/plugin-contract/protocol` | Wire constants and frame types. Zero dependencies. |
| `@fliks/plugin-contract/ui` | UI contributions. Zero dependencies. |

The barrel also re-exports `fliksRangeVersion`, the one helper that needs `semver` — an optional
peer dependency. Take a runtime value from the barrel and your bundler cannot drop it, which is why
values come from a leaf.

A `process` plugin ships as a single bundled `plugin.js`: an archive carries no `node_modules`, so
an unbundled `require` of this package fails at spawn. See `examples/plugin-scaffold`.

## Versioning

Each release's tarball carries that **core** release's version — the number your manifest's `fliks`
range already talks about. The committed `version` here is a placeholder; CI stamps the real one
when it packs (`.github/workflows/plugin-contract-asset.yml`).

What decides compatibility is `PLUGIN_API_VERSION`, the contract revision core answers a plugin in.
A plugin declares the revision it speaks as `pluginApi`; core refuses a manifest whose revision it
does not support, and `SUPPORTED_PLUGIN_API_VERSIONS` is the window in which you republish.

## Source

`backend/src/common/plugin-contract/` in `fliks-app/fliks`. Core and the Fliks web client both
compile these exact files, so there is no separate copy that can drift from what core enforces.
