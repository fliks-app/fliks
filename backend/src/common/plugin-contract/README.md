# @fliks/plugin-contract

Type definitions and protocol constants for Fliks plugins. Types and constants only — no runtime
wiring, no core code. Everything here is erased at build time, so depending on this package does
not put anything of core inside your plugin.

```bash
npm install --save-dev @fliks/plugin-contract
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

The package version tracks `PLUGIN_API_VERSION`, the contract revision core answers a plugin in.
A plugin declares the revision it speaks as `pluginApi` in its manifest; core refuses a manifest
whose revision it does not support. A new major here means a breaking change to a frozen item —
see `docs/plugins.md` in the core repository for what is frozen and what may still move.

## Source

`backend/src/common/plugin-contract/` in `fliks-app/fliks`. Core and the Fliks web client both
compile these exact files, so there is no separate copy that can drift from what core enforces.
