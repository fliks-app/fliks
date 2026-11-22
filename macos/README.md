# Fliks — macOS Native App

A lightweight menu bar app that runs the Fliks media server natively on macOS with **VideoToolbox hardware acceleration**.

The server runs in the background. The UI is accessed through your browser at `http://localhost:4848`.

## Prerequisites

- **macOS 13+** (Ventura or later)
- **Xcode 16+** with command line tools
- **Homebrew**

Install required tools:

```bash
brew install xcodegen postgresql@18 ffmpeg
```

## Build & Run

### 1. Generate the Xcode project

```bash
cd macos
xcodegen generate
```

### 2. Install dependencies & build the web app

```bash
# Client (Angular)
cd ../client
npm ci
npx ng build --configuration=production
```

> The bundle's ffmpeg, ffprobe, fpcalc and mkvmerge come from the engine tools pack pinned in `engine.lock`, fetched by `build-app.sh`. During development, the app uses Homebrew-installed versions instead. `fliks-engine` and `fliks-server` only exist in a bundle built by `build-app.sh`.

### 3. Build & run

Open in Xcode:

```bash
open Fliks.xcodeproj
```

Hit **⌘R** to build and run. A film icon appears in your menu bar.

Alternatively, build from the command line:

```bash
xcodebuild -project Fliks.xcodeproj -scheme Fliks -configuration Debug build ONLY_ACTIVE_ARCH=YES
```

Then launch:

```bash
open "$(find ~/Library/Developer/Xcode/DerivedData/Fliks-*/Build/Products/Debug -name 'Fliks Server.app' -type d | head -1)"
```

## Release build (DMG)

To create a self-contained, distributable DMG:

```bash
./Scripts/build-app.sh
./Scripts/make-dmg.sh
```

This will:
1. Build the client and `fliks-server`, fetch `fliks-engine` and the tools pack (pinned in `engine.lock`)
2. Build the Swift app (Release)
3. Copy PostgreSQL, the engine and the server into the app bundle
4. Recursively bundle all dylib dependencies (`bundle-dylibs.sh`)
5. Code sign everything
6. Create `build/Fliks-<version>-arm64.dmg` with drag-to-Applications layout

Use `--skip-web` to skip rebuilding the client if unchanged:

```bash
./Scripts/build-app.sh --skip-web
./Scripts/make-dmg.sh
```

## What happens on launch

1. **PostgreSQL 18** initializes (first run only) and starts on port **5433**
2. **fliks-engine** listens on port **4848** and runs **fliks-server** behind it on 4849
3. On first launch, your browser opens to `http://localhost:4848` for initial setup
4. **VideoToolbox** hardware acceleration is auto-detected

## Menu bar

| Action | Description |
|--------|-------------|
| **Open Fliks** | Opens the web UI in your default browser |
| **Start at Login** | Toggle auto-start on macOS login |
| **Restart Server** | Stops and restarts PostgreSQL and the server |
| **View Logs** | Opens the log directory in Finder |
| **Quit Fliks** | Gracefully shuts down all processes |

## Data locations

| Path | Contents |
|------|----------|
| `~/Library/Application Support/Fliks Server/postgresql/` | Database cluster |
| `~/Library/Application Support/Fliks Server/conf/` | JWT secret and `.db-password`, the generated password of the `fliks_app` role the server connects with |
| `~/Library/Application Support/Fliks Server/private/` | `.db-admin-password`, the generated password of the `fliks` superuser (mode 0700, tray only, not passed to the server) |
| `~/Library/Application Support/Fliks Server/data/images/` | Cached posters & fanart |
| `~/Library/Application Support/Fliks Server/logs/` | PostgreSQL and server logs (`server-<date>.log`), kept 14 days |
| `/tmp/transcode/` | HLS transcode cache (ephemeral) |

## Database access

The bundled Postgres only listens on TCP loopback (no unix socket) and every login needs a password. The server
connects as the non-superuser `fliks_app` with `conf/.db-password`; the tray (and a manual `psql` as
`-h localhost -p 5433 -U fliks`, `PGPASSWORD`) uses the superuser password in `private/.db-admin-password`. A future
`pg_upgrade` needs its own `--socketdir`.

At each launch the tray runs the bundled `fliks-server db-role`, which hands the database to `fliks_app`
(idempotent, immediate when nothing is missing). Deleting `conf/.db-password` is safe: the next launch sets a new
`fliks_app` password. Deleting `private/.db-admin-password` is not enough to recover the superuser: delete
`conf/.db-password` too, and the next launch resets both. Back up `private/` with `conf/` and the cluster.

Rollback: a build older than the app role reads `conf/.db-password` as the superuser password. Before running it,
copy `private/.db-admin-password` over `conf/.db-password`.

## Clean reset

To wipe all data and start fresh:

```bash
rm -rf ~/Library/Application\ Support/Fliks\ Server
```

## Project structure

```
macos/
├── Fliks/
│   ├── App/FliksApp.swift              # @main entry, MenuBarExtra
│   ├── State/
│   │   ├── AppState.swift              # Startup/shutdown orchestrator
│   │   └── ServerState.swift           # Lifecycle state enum
│   ├── MenuBar/MenuBarView.swift       # SwiftUI menu content
│   ├── Services/
│   │   ├── PostgresManager.swift       # Embedded PostgreSQL lifecycle
│   │   ├── ServerManager.swift         # Engine + fliks-server process management
│   │   └── ConfigStore.swift           # Persistent settings
│   └── Utilities/
│       ├── Paths.swift                 # All file paths (bundle + Homebrew fallbacks)
│       └── ProcessRunner.swift         # Async Process wrapper
├── Scripts/
│   ├── build-app.sh                   # Full release build pipeline
│   ├── bundle-dylibs.sh               # Recursive dylib relocation
│   └── make-dmg.sh                    # Create distributable DMG
└── project.yml                        # XcodeGen spec (generates .xcodeproj)
```
