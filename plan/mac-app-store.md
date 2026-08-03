# Plan — ship the Electron desktop client on the Mac App Store

Status: **planned, not started**. Written 2026-08-04.

Goal: a genuinely good Fliks app on the Mac App Store, built from the Electron
client under `desktop/` (mpv playback), replacing the current "Designed for iPad"
Mac listing.

Scope note: this is about `desktop/` (the thin client). The SwiftUI menu-bar
**server** host under `macos/` can never go to the Mac App Store — it spawns
PostgreSQL/Node/FFmpeg and downloads binaries, which guideline 2.4.5 (ii)/(iii)/(iv)
forbids outright. It stays a notarized DMG.

## Decisions taken

| Question | Decision | Why |
| --- | --- | --- |
| Store presence today | `media.fliks.app` is live on the Mac App Store as "Designed for iPad. Not verified for macOS" (macOS 13.5 + Apple silicon) | Verified on the public product page |
| iPad-on-Mac listing | Turn it **off now** | It is buggy and unfit for Mac; the toggle is free, reversible, needs no build |
| App record | **Add the macOS platform to the existing `media.fliks.app` record** (universal purchase) | One record, one listing, "Add Platform" in App Store Connect; releasing it permanently replaces the iPad-on-Mac listing, which is the desired outcome |
| MAS bundle id | `media.fliks.app` — set via `mas.appId`, leaving the DMG on `media.fliks.desktop` | Universal purchase requires the bundle id to match iOS; `mas.appId` is honoured independently of `mac.appId`, so the DMG channel and its users' data are untouched |
| Architecture | **arm64 only**, `minimumSystemVersion: 12.0` | Apple explicitly allows arm64-only when the minimum OS is macOS 12+ and the app never shipped Intel. Intel can be added later, never removed |
| Media stack | Rebuild libmpv + FFmpeg **LGPL-only, from source, as a single static dylib** | GPL is the documented reason every mpv-based player is absent from the store (VLC 2011 precedent) |
| Acquisition UI (Torznab/qBittorrent strings in the bundle) | **Do not strip up front.** Hold the stripped Angular variant in reserve | The iOS app shipped and was approved with the exact same strings in its bundle. Precedent beats speculation |
| Distribution | Keep the notarized DMG **and** ship MAS | Apple allows both (Emby does it); different bundle ids, separate containers |

## Step 0 — free, do it first (no build, no review)

App Store Connect → Fliks → *Pricing and Availability* → "iPhone and iPad Apps on
Apple Silicon Mac" → *Apple Silicon Mac Availability* → deselect "Make this app
available" → Save.

App-level, applies to all versions, reversible, effective within ~24 h. Existing
Mac installs are never removed remotely.

**Do not click "Verify Compatibility"** next to it — Apple: "Once verified, this
option will no longer be available in App Store Connect".

## Blockers, by class

### Licensing — the only hard wall

Verified in the shipped binaries, not inferred:

- Homebrew FFmpeg is built `--enable-gpl --enable-version3 --enable-libx264
  --enable-libx265` → GPL-3.0-or-later.
- `libmpv.dylib` reports `gpl` in its feature list → GPL-2.0-or-later.
- `libx264`, `libx265`, `librubberband`, `libbluray`/`libudfread` are real
  link-time edges of the shipped `libavcodec` / `libmpv`.
- `desktop/native/vendor/libmpv.so.2` (the one git-tracked file under `vendor/`)
  is built `--enable-gpl --enable-nonfree` — **not redistributable at all**.
  `vendor-libmpv-mac.sh:66`'s `rm -f` is undone by any checkout.
- Fliks' own code is AGPL-3.0 with effectively a single copyright holder
  (758/760 commits), so a dual-license / App Store exception is a decision, not
  an engineering problem. x264's licence cannot be waived the same way.

Apple runs no licence audit and there is no ingestion check: the exposure is
copyright-holder enforcement after publication (VLC was pulled only after a
complaint). It is real but it is not a review gate.

An LGPL rebuild loses nothing this app exercises. FFmpeg's GPL list contains no
decoders (DTS-HD/XLL, TrueHD/MLP, EAC3, HEVC 10-bit, VC-1, all subtitle codecs
are native LGPL; AV1 via dav1d is BSD-2), `bwdif` is not GPL-gated, and mpv
`-Dgpl=false` only drops cdda/dvdnav/dvbin/jack/oss/caca/direct3d/x11 — none
reachable on macOS. The encoders in the tree (x264/x265/SvtAv1Enc/mp3lame) are
dead weight in a playback client, and rubberband is never engaged (`speed` uses
mpv's built-in scaletempo2).

**TLS is the one real trade-off.** `mbedTLS` and GnuTLS(+GMP) are in FFmpeg's
`version3` list and LibreSSL is `nonfree`, so the only path that keeps the stack
at LGPL-2.1 (the licence VideoLAN adopted precisely to allow App Store
distribution) is `--enable-securetransport`, which caps at **TLS 1.2**. A
TLS-1.3-only server would fail. Keep a `FLIKS_MPV_TLS=openssl` escape hatch
(→ LGPLv3+, to be avoided).

### Packaging (all fixable, no dead end)

- No `mas` target anywhere: `desktop/electron-builder.yml:70-86` is dmg+zip,
  Developer ID, hardened runtime, notarize. The `mas` target pulls a **different
  Electron build** — the standard darwin build will not launch under App Sandbox.
- No `build/entitlements.mas.plist`. If it is missing, electron-builder silently
  falls back to its own `entitlements.mac.plist` (no `app-sandbox`, with
  `disable-library-validation`) → ITMS-90296 at upload.
- `entitlements` and `entitlementsInherit` point at the same file
  (`electron-builder.yml:84-85`); the four helpers need `app-sandbox` +
  `com.apple.security.inherit` only.
- Entitlement set to target (empirically matched to a live MAS Electron app —
  Bitwarden ships `allow-jit` only and deleted the other two in commit e1778f4):
  parent = `app-sandbox`, `network.client`, `application-groups
  85ZC7Y8WQ2.media.fliks.app`, `cs.allow-jit`; inherit = `app-sandbox`,
  `inherit`, `cs.allow-jit`. Drop `disable-library-validation` and
  `allow-unsigned-executable-memory`. Note `mas.hardenedRuntime` is inverted in
  electron-builder: off unless explicitly `true`.
- Missing credentials: a **Mac Installer Distribution** cert (electron-builder
  hardcodes CN `3rd Party Mac Developer Installer` for `productbuild` and throws
  without it) and a **Mac App Store provisioning profile** (there is no
  `-allowProvisioningUpdates` equivalent, so it must be supplied as a file;
  mintable non-interactively via the ASC API `profileType: MAC_APP_STORE` or
  `fastlane sigh --platform macos`; expires yearly).
- Already reusable: `APPSTORE_API_KEY_ID` / `_ISSUER_ID` / `_KEY_P8_BASE64`,
  `APPLE_TEAM_ID`, the throwaway-keychain block and the `altool` upload step
  (`--type macos` instead of `ios`), and release-please's existing `v*` fan-out.
- `electron-updater` must be compiled out for MAS: `autoUpdater` is disabled in
  the MAS Electron build and 2.4.5 (vii) forbids self-updating.
- Build number: `-c.extraMetadata.version` sets `CFBundleShortVersionString` ==
  `CFBundleVersion`, so any re-upload is rejected as a duplicate. Add
  `-c.buildVersion=$(git rev-list --count HEAD)` with `fetch-depth: 0`.
- Notarization is skipped for MAS by electron-builder; a `.pkg` is mandatory.
- Also: `xattr -cr` before signing (no `com.apple.quarantine` since 2025-02-18),
  `CFBundleIconName` + `Assets.car`, narrow `files:` to
  `native/build/Release/*.node` (a stray `.o` → ITMS-90135), exclude
  `native/vendor/*.so*` from the mac build.
- Nested Mach-O under `Contents/Resources/app.asar.unpacked/` **is** accepted
  today (proven by a shipping MAS Electron app), but TN2206 reserves the right to
  reject nonstandard placement without notice. Relocating to
  `Contents/Frameworks` is nearly free: every vendored dylib is already
  `@loader_path`-relative and the addon has no link-time libmpv dependency (it
  dlopens `FLIKS_MPV_PATH`). The static single-dylib rebuild makes this trivial.

### Review

- The category is fine: Infuse, Emby, VidHub, Home Assistant and Immich all ship
  free clients that require a user-run server.
- 2.1 (demo account) is the main wildcard, but iOS **and** tvOS were approved with
  no demo server and no demo mode. Mitigation costs no code: review notes with a
  reachable demo host and **non-admin** credentials.
- 5.2.3 (acquisition UI): the same strings shipped in the approved iOS bundle, and
  the routes are behind `adminGuard`. Keep a **non-admin** demo account so the UI
  is unreachable, keep torrent/indexer wording out of the App Store description,
  keywords and screenshots. Only build the stripped variant if Apple actually
  raises it.
- 4.2 (web wrapper) is defensible on the engine: in-process libmpv on a
  CAOpenGLLayer, `hwdec=videotoolbox`, content-adaptive EDR/HDR, Direct Play,
  offline downloads. Keep the phrase "thin client" out of review notes.
- 2.5.1: Apple's static analysis has repeatedly flagged private symbols inside
  Electron Framework. Out of our control; the `mas` Electron build is the
  mitigation.

## What is already fine (no work needed)

- No local listening socket anywhere (`grep createServer|\.listen(` → nothing);
  `hls-mirror.ts` is an outbound `net.request` loop, `cors.ts` a header rewriter.
  So no `network.server` entitlement is needed.
- All writes are container-relative already: `download.ts:25`
  (`userData/downloads`) and `log-file.ts:10-14` (`app.getPath('logs')`). No file
  entitlement, no security-scoped bookmarks — the client never touches the user's
  media files, it streams from the server.
- No child process on the macOS playback path (libmpv is in-process).
- `sw_vers` / `scutil` (`index.ts:109,148`) degrade to their existing fallbacks
  under the sandbox.

## Collateral bugs found (independent of the store)

1. **P0 — the current DMG cannot play video on macOS 12 through 15.** 46 of 47
   vendored dylibs declare `minos 26.0` (Homebrew bottles inherit the build OS)
   while the bundle declares `LSMinimumSystemVersion 12.0`; dyld refuses to load
   them. Add a CI gate asserting `max(minos) <= LSMinimumSystemVersion`; the
   from-source rebuild is the real fix.
2. The `av_*` kill-switch in `desktop-release.yml:225` inspects only
   `libmpv.dylib` while `libavcodec` sits beside it exporting 452 `_av*` symbols.
   It passes for the wrong reason, and a static build needs an explicit
   `-Wl,-exported_symbols_list` with `_mpv_*`.
3. `native/vendor/libmpv.so.2` — a 37 MB Linux x86-64 ELF built `--enable-nonfree`
   — is git-tracked and ships inside the macOS `.app`.
4. `index.ts:40-46` accepts every invalid TLS certificate for every host,
   including the GitHub update feed and image.tmdb.org.
5. `Menu.setApplicationMenu(null)` (`index.ts:234`) is a **no-op on macOS**: the
   app currently ships Electron's stock developer menu, including "Toggle
   Developer Tools" and "Force Reload", with English labels next to localized
   system ones.
6. Every window command is inert, because the key/main window is the frameless
   child overlay: ⌘W, ⌘M and Toggle Full Screen do nothing (verified over the
   accessibility API on the built bundle), the framed window reports
   `AXMain=false` so its title bar draws inactive, and the Window menu plus
   VoiceOver expose three windows.
7. `window-all-closed` quits unconditionally (no darwin guard, no `activate`).
8. Fullscreen state is a renderer-local boolean, so any native transition
   desynchronises the UI and can trap the user in fullscreen.
9. `Info.plist` ships Electron's boilerplate camera / microphone / Bluetooth /
   audio-capture usage strings and no `NSLocalNetworkUsageDescription`, while
   macOS 15+ gates all LAN traffic.
10. No `setWindowOpenHandler`: an external link opens a chrome-less Electron
    window inheriting `webSecurity: false` and the preload.
11. Dead PiP control on desktop (`pipAvailable` defaults true, corrected only in
    the Capacitor branch) — a visible button that does nothing is a 2.1 finding.

## Phases and effort

| # | Phase | Effort | Valuable without the store |
| --- | --- | --- | --- |
| 0 | Turn off the iPad-on-Mac listing; add the `minos` CI gate | 0.2 d | — |
| 1 | LGPL media stack from source: 14 pinned deps as static archives → **one** `libmpv.dylib`, explicit `-mmacosx-version-min=12.0`, `_mpv_*` export list, SecureTransport | 5–8 d | **Yes — fixes bug 1** |
| 2 | macOS shell: real localized application menu (no DevTools in packaged builds), window commands bound to the framed window, fullscreen event in the contract, darwin lifecycle (`activate` / hide on close), window-state persistence, `Info.plist` hygiene + `NSLocalNetworkUsageDescription`, `setWindowOpenHandler` + `will-navigate` guard, TLS bypass scoped to the configured server host, dead PiP control off, non-selectable text, `<html lang>`, darwin `before-quit` teardown | 6–8 d | **Yes** |
| 3 | Now Playing: `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` in the existing ObjC++ addon (media keys, Control Center, widget) + a Playback menu | 2–3 d | **Yes** |
| 4 | MAS packaging: `mas` target + `mas.appId`, two entitlements plists, installer cert, App ID + provisioning profile, `ElectronTeamID`, `buildVersion`, updater compiled out, `xattr -cr`, `extendInfo`, relocate native code to `Contents/Frameworks`, new `mac-app-store-publish.yml` (~80 % copied from `desktop-release.yml` + `appstore-publish.yml`) | 3–5 d | No |
| 5 | Review prep: permanent public demo server + non-admin credentials, review notes, Mac screenshots, privacy label, QA matrix (resize during 4K HDR, XDR→SDR move, display unplug in fullscreen, ⌘Q mid-playback) | 2–3 d + infra | No |
| — | *In reserve*: Angular App Store variant (`ng build --configuration=production,appstore` with `fileReplacements`, i18n strip, CI guard against reappearance) — only if Apple raises 5.2.3 | 5–6.5 d | No |
| — | *Later*: single-window macOS refactor (fixes the inactive title bar, the 3-window accessibility tree, unlocks `hiddenInset` + vibrancy) | 3–5 d, medium risk | Yes |
| — | *Later*: Intel support (universal build) | 4–8 d | — |

**Total before submission ≈ 19–28 d**, of which 13–19 d improve the shipped DMG
whether or not the store happens.

Suggested order: 0 → 1 → 2 → 3 (all DMG-positive) → 4 → 5. Validate the sandbox
with a `mas-dev` build on a throwaway bundle id before touching the real record,
then use TestFlight for macOS (up to 10 000 external testers, Beta App Review on
the first build only) to check sandboxed playback against real libraries.

## Open questions

- Is `IOS_DIST_CERT_P12_BASE64` an "Apple Distribution" cert (works for a MAS
  bundle) or a legacy "iOS Distribution" one? If the latter, a Mac App
  Distribution cert secret is needed on top of the installer cert.
- Who mints and rotates the Mac App Store provisioning profile (yearly, no cloud
  fallback in electron-builder)?
- Keep quit-on-last-window-close, or true macOS lifecycle (hide + reopen on dock
  click)? The latter means the mpv session must survive or be re-created on
  `activate`.
- Does the MAS build's sandbox container (`~/Library/Containers/media.fliks.app`)
  actually contain the old iPad-on-Mac app's `UserDefaults`? If so, a ~0.5 d
  one-time migration can pre-fill the server URL instead of dropping those users
  on the setup screen.
- Is TLS 1.2 (SecureTransport) acceptable for every deployed Fliks server?
