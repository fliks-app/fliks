# Fliks — Windows Native Server

A lightweight system-tray app that runs the Fliks media server natively on
Windows with **hardware transcoding** (Intel QSV · AMD AMF · NVIDIA NVENC,
auto-detected at startup).

The server runs in the background; the UI is accessed through your browser at
`http://localhost:4848`. This is the Windows counterpart of the macOS menu-bar
server host under [`macos/`](../macos) — same architecture, Windows-native
mechanisms.

## Architecture

| Concern | macOS (`macos/`) | Windows (`windows/`) |
|---------|------------------|----------------------|
| Tray UI | SwiftUI `MenuBarExtra` | C#/.NET 8 WinForms `NotifyIcon` |
| Code discovery | symlink dist/node_modules into a writable cwd | run `node <dist>\main.js` by absolute path, cwd = writable data dir (Node resolves `node_modules` from the script path — no symlinks) |
| PostgreSQL | Homebrew bottle + dylib relocation | EDB binaries zip (self-contained, no relocation) |
| FFmpeg | Homebrew + dylib relocation | jellyfin-ffmpeg gpl build (QSV + AMF + NVENC + OpenCL, incl. zero-copy D3D11↔OpenCL P010 for HDR tone-map) |
| Autostart | `SMAppService` | `HKCU\…\Run` registry value |
| Package | DMG | Fliks installer window around Velopack's silent Setup.exe; updates from the tray |

## Prerequisites (build machine)

- **Windows 10/11 x64**
- **.NET 8 SDK**
- **Node.js** (for building client + backend)
- **vpk** (`dotnet tool install -g vpk`) — for the Setup.exe
- **Windows SDK** (`signtool`) — only for signing

## Build & run

```powershell
cd windows

# 1. Fetch vendored binaries (Node, PostgreSQL, FFmpeg) into .\Vendored
.\Scripts\fetch-vendored.ps1

# 2. Build client + backend + tray, assemble .\build\Bundle
$env:TMDB_API_KEY = "..."   # optional; baked into the tray
$env:TVDB_API_KEY = "..."
.\Scripts\build-app.ps1

# 3. Package the Velopack release (.\build\Releases) and the installer that wraps it
#    → .\build\Setup\Fliks-Server-1.0.0-Setup.exe
.\Scripts\make-setup.ps1 -Version 1.0.0
```

For a dev run without packaging, `dotnet run --project Fliks.Tray` uses the
vendored binaries and the repo's `backend/dist` + `client/dist` directly.

## What happens on launch

1. **PostgreSQL 18** initializes (first run only) and starts on port **5433**.
2. **Node.js** starts the NestJS backend on port **4848**.
3. On first launch, your browser opens to `http://localhost:4848` for setup.
4. Hardware transcoding is auto-detected: **QSV → AMF → NVENC → CPU**.
   NVENC needs a recent NVIDIA driver (**≥ 570**); on older drivers NVENC is
   skipped and NVIDIA falls back to CPU. AMD runs a full-GPU pipeline
   (D3D11 decode → `scale_d3d11` → AMF encode) on the bundled FFmpeg 8.1.

## Tray menu

| Action | Description |
|--------|-------------|
| **Open Fliks** | Open the web UI in your default browser |
| **Start at Login** | Toggle auto-start (per-user `Run` key) |
| **Restart Server** | Stop and restart PostgreSQL + Node.js |
| **View Logs…** | Open the log folder in Explorer |
| **Quit Fliks** | Gracefully shut down all processes |

## Data locations

| Path | Contents |
|------|----------|
| `%LOCALAPPDATA%\Fliks Server\postgresql\` | Database cluster |
| `%LOCALAPPDATA%\Fliks Server\conf\` | JWT secret + tray settings |
| `%LOCALAPPDATA%\Fliks Server\data\` | Backend cwd (images, thumbnails, backups) |
| `%LOCALAPPDATA%\Fliks Server\logs\` | Backend + PostgreSQL logs |
| `%LOCALAPPDATA%\Fliks Server\transcode\` | HLS transcode cache (ephemeral) |

Setup installs the app under `%LOCALAPPDATA%\FliksServer` (per-user, no admin);
the tray offers new releases and applies them after stopping PostgreSQL and node.
Uninstalling removes that folder only and leaves `%LOCALAPPDATA%\Fliks Server` data intact.

## Clean reset

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Fliks Server"
```

## CI

[`.github/workflows/windows-installer.yml`](../.github/workflows/windows-installer.yml)
builds on `windows-latest` for PRs, manual dispatch and `v*` tags; tags attach the
Velopack files (`win-server` channel) to the release. Provide `WINDOWS_CERT_PFX_BASE64`
+ `WINDOWS_CERT_PASSWORD` secrets to Authenticode-sign; without them it ships unsigned
(SmartScreen warns on download).

## Status / not yet validated on hardware

This bundle can't be built or exercised on the Linux dev box. Before shipping,
validate on real Windows hardware:

- QSV / AMF / NVENC transcode + HDR→SDR paths per GPU vendor.
- EDB PostgreSQL binaries URL/version (`fetch-vendored.ps1` `$PgVersion`).
- OpenCL tonemap device selection (`FLIKS_OPENCL_DEVICE` — see backend).
- Drop a real `fliks.ico` into `Fliks.Tray/Resources/`.
