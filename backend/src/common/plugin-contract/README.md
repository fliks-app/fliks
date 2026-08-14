# @fliks/plugin-contract

Type definitions and protocol constants for Fliks plugins. Types and constants only — no runtime
wiring, no core code. Everything here is erased at build time, so depending on this package does
not put anything of core inside your plugin.

```bash
npm install --save-dev @fliks/plugin-contract
```

## Two entry points

```ts
import type { ProcessPluginManifest, HostMethod } from '@fliks/plugin-contract';
import { PLUGIN_API_VERSION, PLUGIN_DEADLINES_MS } from '@fliks/plugin-contract';

// UI contributions alone — no dependencies, safe in a browser bundle.
import type { ConfigPage, UiContribution } from '@fliks/plugin-contract/ui';
```

The root export covers the manifest, both method tables, the principal, the wire protocol and the
UI contributions. `semver` is an optional peer dependency, needed only if you call the version
helpers in `protocol`.

## Versioning

The package version tracks `PLUGIN_API_VERSION`, the contract revision core answers a plugin in.
A plugin declares the revision it speaks as `pluginApi` in its manifest; core refuses a manifest
whose revision it does not support. A new major here means a breaking change to a frozen item —
see `docs/plugins.md` in the core repository for what is frozen and what may still move.

## Source

`backend/src/common/plugin-contract/` in `fliks-app/fliks`. Core and the Fliks web client both
compile these exact files, so there is no separate copy that can drift from what core enforces.
