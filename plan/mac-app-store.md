# Plan — ship the Electron desktop client on the Mac App Store

Status: **planned, not started**. Written 2026-08-04, revised 2026-11-20 against
main `13d2ad8f3`.

Goal: a genuinely good Fliks app on the Mac App Store, built from the Electron
client under `desktop/` (in-process libmpv), replacing the current "Designed for
iPad" Mac listing, while the notarized DMG (`media.fliks.desktop`) keeps shipping.

Scope note: this is about `desktop/`. The SwiftUI menu-bar **server** host under
`macos/` can never go to the Mac App Store — it spawns PostgreSQL/Node/FFmpeg and
downloads binaries, which guideline 2.4.5 (ii)/(iii)/(iv) forbids. It stays a
notarized DMG.

## Decisions taken

| Question | Decision | Why |
| --- | --- | --- |
| Store presence today | `media.fliks.app` is live on the Mac App Store as "Designed for iPad" (macOS 13.5 + Apple silicon) | Verified on the public product page |
| App record | **Add the macOS platform to the existing `media.fliks.app` record** (universal purchase) | One record, one listing; releasing it replaces the iPad-on-Mac listing and updates its existing users to the macOS app (ASC help) |
| iPad-on-Mac toggle | Left **on** until the macOS build is approved; turned off at the macOS release (phase 5) | Turning availability off months earlier may forfeit the in-place replacement. Never click "Verify Compatibility" (irreversible) |
| MAS bundle id | `media.fliks.app` via `mas.appId`; the DMG stays on `media.fliks.desktop` | Universal purchase needs the iOS bundle id; `mas.appId` is independent of `mac.appId` |
| Architecture / OS floor | **arm64 only**, minimum **macOS 13.0** | Electron 45 itself requires 13; arm64-only is allowed at 12+ for an app that never shipped Intel. Intel can be added later, never removed |
| Media stack | libmpv + FFmpeg rebuilt **from source, LGPL-2.1, TLS = OpenSSL 3**, as a single static dylib; no SecureTransport, no TLS escape hatch | GPL is why mpv players are absent from the store. OpenSSL ≥ 3 is accepted in a non-GPL FFmpeg build (LGPL-2.1+), keeps TLS 1.3, and avoids deprecated Apple API (2.4.5(viii)) |
| Build recipe | Reuse the Linux pins: FFmpeg n8.1.2, mpv v0.41.0, libplacebo v7.351.0, libass 0.17.4 (`build-libmpv-linux.sh`) | One set of versions to maintain; the Mac script pins nothing today (Homebrew) |
| CI | A `mas` matrix row in `desktop-release.yml`, not a copied workflow | The `v*` fan-out, signing and upload steps already exist there |
| Updater | MAS build gated on `process.mas` in one place (the capability `updater.ts` reports), so the client update UI and the GitHub releases link hide themselves | MAS forbids self-updating (2.4.5(vii)); no build-time compile-out |
| Acquisition UI | Nothing to strip: the client carries no torrent/indexer acquisition UI any more (acquisition moved to plugins) | Re-check before submission |
| Distribution | Notarized DMG **and** MAS | Different bundle ids, separate containers |

## Blockers, by class

### Licensing — the only hard wall

Verified in the shipped binaries:

- The vendored FFmpeg is Homebrew's, built `--enable-gpl --enable-version3
  --enable-openssl --enable-libx264 --enable-libx265` (GPLv3); `libmpv.dylib`
  reports `gpl`; x264/x265/rubberband/libbluray are link-time edges.
- Fliks' own code is AGPL-3.0 with effectively one copyright holder (2,581
  commits, one external contributor with 2 commits, plus bots). Check the 7 owner
  commits made under a work email before any dual-licensing decision. No copyleft
  in the shipped npm dependencies.

Apple runs no licence audit; the exposure is copyright-holder enforcement after
publication, not a review gate.

An LGPL rebuild loses nothing this app exercises: FFmpeg's GPL list has no
decoders (DTS-HD, TrueHD, EAC3, HEVC 10-bit, VC-1 and subtitle codecs are native
LGPL; AV1 is dav1d, BSD-2); `bwdif` is not GPL-gated; mpv `-Dgpl=false` only drops
cdda/dvdnav/dvbin/jack/oss/caca/direct3d/x11. x264/x265/SvtAv1/mp3lame are dead
weight in a playback client; rubberband is never engaged (`speed` uses
scaletempo2).

The rebuild links **OpenSSL 3** (`--enable-openssl`, no `--enable-gpl`, no
`--enable-version3`): configure accepts it and the result is "LGPL version 2.1 or
later" by configure; FFmpeg's own LICENSE.md calls Apache-2.0 code incompatible with LGPL v2.1, so ship the stack as LGPL-3 to be safe (owner's call, a legal point rather than an engineering one). mpv opens https itself through FFmpeg, so FFmpeg's TLS backend governs all
playback; Electron's BoringSSL only carries the UI, downloads and `hls-mirror`.
Disable libshaderc, the Vulkan loader, lua, js and libarchive (unused on the GL
path).

### Platform risks to accept and name

- Playback renders through mpv's render API on CGL/OpenGL (deprecated tech) into a
  `CAMetalLayer` (`native/player_mac/addon.mm`); mpv's render API has no Metal
  backend. Known 2.4.5(viii)/2.5.1 risk, no mitigation available.
- Apple's static analysis has flagged private symbols inside Electron Framework;
  the `mas` Electron build is the mitigation.
- Nested Mach-O under `Contents/Resources/app.asar.unpacked/` is accepted today,
  but TN2206 reserves the right to reject it. Relocate native code to
  `Contents/Frameworks`: every vendored dylib is `@loader_path`-relative and the
  addon dlopens `FLIKS_MPV_PATH`.

### Packaging (all fixable)

- No `mas` target: `desktop/electron-builder.yml` mac config is dmg+zip, Developer
  ID, hardened runtime, notarize. The `mas` target pulls a **different Electron
  build** (the standard one will not launch under App Sandbox).
- electron-builder builds the mas config as `deepAssign(mac, mas)`, so mas inherits
  `mac.entitlements` and `mac.hardenedRuntime`. Set `mas.entitlements` and
  `mas.entitlementsInherit` **explicitly**, to two new plists (the
  `build/entitlements.mas.plist` auto-pickup only runs when none is configured).
  Inherited `hardenedRuntime: true` is fine for MAS.
- `mas.extendInfo` and `mas.minimumSystemVersion` are ignored by 26.18: Info.plist
  keys go in `mac.extendInfo` (a key set to `null` is deleted — that strips
  Electron's camera/Bluetooth/audio-capture boilerplate strings) and the floor in
  `mac.minimumSystemVersion`.
- Entitlements. Parent: `app-sandbox`, `network.client`, **`network.server`**
  (SSO loopback `oidc-loopback.ts` listens on `127.0.0.1`; Chromecast mDNS binds
  UDP 5353 with multicast membership — UDP needs both), **`device.audio-input`**
  (watch-party voice), `cs.allow-jit`. Inherit (helpers): `app-sandbox`, `inherit`,
  `cs.allow-jit`. Drop `disable-library-validation` and
  `allow-unsigned-executable-memory`. No file entitlement: all writes are
  container-relative. `ElectronTeamID`, `application-identifier` and the
  `TEAMID.bundleid` app group are added by `@electron/osx-sign` when app-sandbox is
  on; nothing manual. No `aps-environment` (desktop push is page-driven).
- Info.plist: add `NSLocalNetworkUsageDescription` (macOS 15+ gates LAN traffic;
  first local-network operations may be denied before the prompt is answered, so
  cast discovery and the first LAN server connect need retries — the 30 s mDNS
  re-query covers discovery) and `ITSAppUsesNonExemptEncryption: false` (as iOS and
  tvOS), plus the `CFBundleIconName` + `Assets.car` icon.
- The macOS multicast entitlement is not required (TN3179). Optional later:
  Bonjour browse of `_googlecast._tcp` in the addon and `ASWebAuthenticationSession`
  for SSO would drop `network.server`.
- Credentials: the **Mac Installer Distribution** cert is the only missing cert
  (`IOS_DIST_CERT_P12_BASE64` is an Apple Distribution cert, which electron-builder
  looks for first for mas). A **Mac App Store provisioning profile** must be
  supplied as a file (mintable via the ASC API `MAC_APP_STORE` or `fastlane sigh`;
  expires yearly). Reusable: `APPSTORE_API_KEY_*`, `APPLE_TEAM_ID`, the `altool`
  upload (`--type macos`), release-please's `v*` fan-out.
- CI composite actions `.github/actions/import-keychain` and `stage-asc-key`:
  `import-keychain` writes a fixed `$RUNNER_TEMP/app-signing.keychain-db`, so it
  takes a list of p12s (Distribution + Installer in one keychain) rather than being
  called twice.
- Build number: `-c.extraMetadata.version` sets `CFBundleShortVersionString` ==
  `CFBundleVersion`, so a re-upload is a duplicate. Pass `-c.mas.bundleVersion` (or
  `buildVersion`) from `git rev-list --count HEAD` (`fetch-depth: 0` is already set).
- Notarization is skipped for MAS; a `.pkg` is mandatory. `xattr -cr` before signing.
- Narrow `files:` to `native/build/Release/*.node` (a stray `.o` → ITMS-90135);
  exclude `native/vendor/*.so*` and `node_modules/velopack/**` (win/linux `.node`
  and `velopack_nodeffi_osx.node`, a Windows-only updater that is a 2.4.5(vii) and
  static-scan risk in MAS) from the mac build.
- Under the sandbox: `notify/status.ts` hard-codes `APP_ID = 'media.fliks.desktop'`
  for the notification-settings deep link — derive it from the running bundle id;
  `setLoginItemSettings` works (SMAppService) and is opt-in (satisfies 2.4.5(iii)),
  re-test `wasOpenedAtLogin`; badges need notification permission; the calendar
  handoff writes `os.tmpdir()` + `shell.openPath` (`index.ts`), untested under the
  sandbox; `sw_vers` / `scutil` calls can become `process.getSystemVersion()`.

### Review

- The category is fine: Infuse, Emby, VidHub, Home Assistant and Immich ship free
  clients that need a user-run server.
- 2.1 (demo account) is the main wildcard, but iOS and tvOS were approved with no
  demo server. Mitigation costs no code: review notes with a reachable demo host
  and **non-admin** credentials.
- 4.2 (web wrapper): defensible on the engine — in-process libmpv, `hwdec=
  videotoolbox`, content-adaptive EDR/HDR, Direct Play, offline downloads. Cite
  4.2.7(e) as the reason to avoid the phrase "thin client" in review notes.
- 4.8: SSO targets the user's own identity provider, so Sign in with Apple does not
  apply. Justify `network.server` in the review notes.
- 5.2.3: nothing to strip today; keep torrent/indexer wording out of the
  description, keywords and screenshots.

## Collateral bugs in the shipped DMG

Open:

1. **P0 — the DMG cannot play video on macOS 13 through 15.** 46 of 47 vendored
   dylibs declare `minos 26.0` (Homebrew bottles inherit the build OS) while the
   bundle declares `LSMinimumSystemVersion 13.0`; dyld refuses to load them. A CI
   gate asserts `max(minos) <= LSMinimumSystemVersion`; the from-source rebuild is
   the real fix.
2. The `av_*` kill-switch (`scripts/verify-libmpv-mac.sh`) inspects only
   `libmpv.dylib` while `libavcodec` sits beside it exporting `_av*`; a static build
   needs an explicit `-Wl,-exported_symbols_list` with `_mpv_*`.
3. `index.ts` accepts every certificate error for every host.
4. Window commands: the key/main window is the frameless child overlay, so ⌘W, ⌘M
   and Toggle Full Screen are inert (to re-test over the accessibility API); the
   framed window reports `AXMain=false` (inactive title bar) and VoiceOver exposes
   three windows.
5. `window-all-closed` quits unconditionally; the dock-click reshow (#2810) exists,
   and close-to-tray applies only with background mode.
6. Fullscreen state is a renderer-local boolean (no fullscreen event in
   `src/shared/contract.ts`): a native transition desynchronises the UI.
7. `Info.plist` ships Electron's camera/Bluetooth/audio-capture strings and no
   `NSLocalNetworkUsageDescription`.
8. Menu role labels are English next to localized system ones; no View or Playback
   menu.
9. No `will-navigate` guard (`setWindowOpenHandler` exists).
10. `<html lang>` is static (`client/src/index.html`), not the UI language.
11. The mac `.app` ships `node_modules/velopack/**` (asarUnpack).
12. Unverified: dead PiP control (`player.ts` sets it false on Electron — likely
    fine).

Fixed since the first draft: Now Playing (#2044), the stock developer menu (#2055),
`setWindowOpenHandler`, the Linux `libmpv.so.2` (built from source; CI deletes it
before packaging — only a local build skipping the vendor script ships it).

## Phases and effort

| # | Phase | Effort | Valuable without the store |
| --- | --- | --- | --- |
| 0 | `minos` CI gate: every vendored Mach-O ≤ `LSMinimumSystemVersion`; kill-switch checks every dylib | 0.3 d | Yes — flags bug 1 |
| S | **Sandbox spike** (parallel with 1): `mas-dev` build on a throwaway bundle id with today's Homebrew dylibs — libmpv dlopen under library validation, CAMetalLayer, the 3-window session, mDNS, SSO loopback, mic, `.ics` `openPath` | ~1 d | — |
| 1 | LGPL media stack from source: Linux pins, static archives → **one** `libmpv.dylib`, `-mmacosx-version-min=13.0`, `_mpv_*` export list, OpenSSL 3, a macOS CI job; Homebrew vendor script retired | 4–6 d | **Yes — fixes bug 1** |
| 2 | macOS shell: localized menu labels, window commands and AX bound to the framed window, fullscreen event in the contract, TLS bypass scoped to the configured server host (and mpv's `tls-verify`, which defaults to no, so `tls-ca-file` is never used today), `will-navigate` guard, `Info.plist` hygiene, runtime `<html lang>`, window state, velopack excluded | 4–6 d | **Yes** |
| 3 | Playback menu (Now Playing already done) | 0.5 d | **Yes** |
| 4 | MAS packaging: third-party notices (LGPL text and source offer for FFmpeg, mpv, libplacebo, fribidi; FreeType credit; OpenSSL licence), `mas` row in `desktop-release.yml`, `mas.appId`, two plists, two-p12 keychain, `process.mas` updater gate, `APP_ID` fix, `buildVersion`, `extendInfo`, native code to `Contents/Frameworks`, upload | 3–5 d | No |
| 5 | Review prep: demo server + non-admin credentials, review notes, Mac screenshots, privacy label, QA matrix (resize during 4K HDR, XDR→SDR move, display unplug in fullscreen, ⌘Q mid-playback, local-network permission denial); at release turn off the iPad-on-Mac availability | 2–3 d + infra | No |
| — | *Later*: single-window macOS refactor (fixes the inactive title bar, the 3-window AX tree; unlocks `hiddenInset` + vibrancy) | 3–5 d | Yes |
| — | *Later*: Intel (universal build) | 4–8 d | — |

**Total before submission ≈ 14–22 d**, most of it improving the shipped DMG.

Order: 0 → (S ∥ 1) → 2 → 3 → 4 → 5. Validate the sandbox with a `mas-dev` build on
a throwaway bundle id before touching the real record, then TestFlight for macOS
(Beta App Review on the first build only) against real libraries.

## Needs the owner

Mac Installer Distribution cert; Mac development cert + profile for `mas-dev` (and
the throwaway App ID); App ID capabilities and the Mac App Store profile; the
macOS platform in App Store Connect; new GitHub secrets (installer p12, profile);
uploading a build; the demo server and screenshots.

## Open questions

- Who mints and rotates the Mac App Store provisioning profile (yearly)?
- Keep quit-on-last-window-close, or true macOS lifecycle (hide + reopen on
  `activate`, mpv session surviving)?
- Does `~/Library/Containers/media.fliks.app` carry the iPad-on-Mac app's data? The
  iPad build keeps its server URL in Capacitor Preferences (UserDefaults); a ~0.5 d
  one-time migration could pre-fill it instead of dropping those users on the setup
  screen.
- Dual-licensing (AGPL + App Store exception) is moot for FFmpeg (LGPL) but Fliks'
  own AGPL code on the store needs the owner's call; check the work-email commits.
