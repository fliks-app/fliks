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
| PostgreSQL | Homebrew bottle + dylib relocation | EDB binaries zip (self-contained, no relocation) |
| FFmpeg | Homebrew + dylib relocation | jellyfin-ffmpeg gpl build (QSV + AMF + NVENC + OpenCL, incl. zero-copy D3D11↔OpenCL P010 for HDR tone-map) |
| Autostart | `SMAppService` | `HKCU\…\Run` registry value |
| Package | DMG | Fliks installer window around Velopack's silent Setup.exe; updates from the tray |

## Prerequisites (build machine)

- **Windows 10/11 x64**
- **.NET 8 SDK**
- **Node.js** (for building the client)
- **Rust toolchain** (cargo, for `fliks-server`)
- **vpk** (`dotnet tool install -g vpk`) — for the Setup.exe
- **Windows SDK** (`signtool`) — only for signing

## Build & run

```powershell
cd windows

# 1. Fetch vendored binaries (PostgreSQL) into .\Vendored
.\Scripts\fetch-vendored.ps1

# 2. Build client + fliks-server + tray, fetch fliks-engine, assemble .\build\Bundle
.\Scripts\build-app.ps1

# 3. Package the Velopack release (.\build\Releases) and the installer that wraps it
#    → .\build\Setup\Fliks-Server-1.0.0-Setup.exe
.\Scripts\make-setup.ps1 -Version 1.0.0
```

For a dev run without packaging, `dotnet run --project Fliks.Tray` uses the
vendored binaries and the repo's `client/dist` and `server/public`; `fliks-engine.exe` and
`fliks-server.exe` must sit in a `bin\` directory beside the tray exe.

## What happens on launch

1. **PostgreSQL 18** initializes (first run only) and starts on port **5433**.
2. **fliks-engine** listens on port **4848** and runs **fliks-server** behind it on 4849.
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
| **Restart Server** | Stop and restart PostgreSQL + the server |
| **View Logs…** | Open the log folder in Explorer |
| **Quit Fliks** | Gracefully shut down all processes |

## Data locations

| Path | Contents |
|------|----------|
| `%LOCALAPPDATA%\Fliks Server\postgresql\` | Database cluster |
| `%LOCALAPPDATA%\Fliks Server\conf\` | JWT secret, `.db-password` (generated password of the `fliks_app` role the server connects with) + tray settings |
| `%LOCALAPPDATA%\Fliks Server\private\` | `.db-admin-password`, the generated password of the `fliks` superuser (tray only, not passed to the server) |
| `%LOCALAPPDATA%\Fliks Server\data\` | Server cwd (images, backups) |
| `%LOCALAPPDATA%\Fliks Server\logs\` | Server (`server-<date>.log`) + PostgreSQL logs, kept 14 days |
| `%LOCALAPPDATA%\Fliks Server\transcode\` | HLS transcode cache (ephemeral) |

Setup installs the app under `%LOCALAPPDATA%\FliksServer` (per-user, no admin);
the tray offers new releases and applies them after stopping PostgreSQL and the server.
Uninstalling removes that folder only and leaves `%LOCALAPPDATA%\Fliks Server` data intact.

## Database access

The server connects as the non-superuser `fliks_app` with `conf\.db-password`; the tray (and a manual `psql` as
`-h 127.0.0.1 -p 5433 -U fliks`, `PGPASSWORD`) uses the superuser password in `private\.db-admin-password`.
At each launch the tray runs the bundled `fliks-server db-role`, which hands the database to `fliks_app`
(idempotent, immediate when nothing is missing). Deleting `conf\.db-password` is safe: the next launch sets a new
`fliks_app` password. Deleting `private\.db-admin-password` is not enough to recover the superuser: delete
`conf\.db-password` too, and the next launch resets both. Back up `private\` with `conf\` and the cluster.

Rollback: a build older than the app role reads `conf\.db-password` as the superuser password. Before running it,
copy `private\.db-admin-password` over `conf\.db-password`.

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
- OpenCL tonemap device selection (`FLIKS_OPENCL_DEVICE` — see the engine).
- Drop a real `fliks.ico` into `Fliks.Tray/Resources/`.
