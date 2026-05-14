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

# Backend (NestJS)
cd ../backend
npm ci
npm run build
```

### 3. Fetch vendored Node.js

The app needs a Node.js 24 binary (not available via Homebrew). The fetch script downloads it:

```bash
cd ../macos
./Scripts/fetch-vendored.sh
```

> This also fetches PostgreSQL and FFmpeg binaries for future standalone distribution. During development, the app uses Homebrew-installed versions instead.

### 4. Build & run

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
open "$(find ~/Library/Developer/Xcode/DerivedData/Fliks-*/Build/Products/Debug -name 'Fliks.app' -type d | head -1)"
```

## Release build (DMG)

To create a self-contained, distributable DMG:

```bash
./Scripts/build-app.sh
./Scripts/make-dmg.sh
```

This will:
1. Build client + backend
2. Build the Swift app (Release)
3. Copy PostgreSQL, FFmpeg, Node.js into the app bundle
4. Recursively bundle all dylib dependencies (`bundle-dylibs.sh`)
5. Code sign everything
6. Create `build/Fliks-<version>-arm64.dmg` with drag-to-Applications layout

Use `--skip-web` to skip rebuilding client/backend if unchanged:

```bash
./Scripts/build-app.sh --skip-web
./Scripts/make-dmg.sh
```

## What happens on launch

1. **PostgreSQL 18** initializes (first run only) and starts on port **5433**
2. **Node.js** starts the NestJS backend on port **4848**
3. On first launch, your browser opens to `http://localhost:4848` for initial setup
4. **VideoToolbox** hardware acceleration is auto-detected

## Menu bar

| Action | Description |
|--------|-------------|
| **Open Fliks** | Opens the web UI in your default browser |
| **Start at Login** | Toggle auto-start on macOS login |
| **Restart Server** | Stops and restarts both PostgreSQL and Node.js |
| **View Logs** | Opens the log directory in Finder |
| **Quit Fliks** | Gracefully shuts down all processes |

## Data locations

| Path | Contents |
|------|----------|
| `~/Library/Application Support/Fliks/postgresql/` | Database cluster |
| `~/Library/Application Support/Fliks/conf/` | JWT secret (auto-generated) |
| `~/Library/Application Support/Fliks/data/images/` | Cached posters & fanart |
| `~/Library/Application Support/Fliks/logs/` | PostgreSQL logs |
| `/tmp/transcode/` | HLS transcode cache (ephemeral) |

## Clean reset

To wipe all data and start fresh:

```bash
rm -rf ~/Library/Application\ Support/Fliks
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
│   │   ├── NodeManager.swift           # Node.js process management
│   │   └── ConfigStore.swift           # Persistent settings
│   └── Utilities/
│       ├── Paths.swift                 # All file paths (bundle + Homebrew fallbacks)
│       └── ProcessRunner.swift         # Async Process wrapper
├── Scripts/
│   ├── fetch-vendored.sh              # Download arm64 binaries
│   ├── build-app.sh                   # Full release build pipeline
│   ├── bundle-dylibs.sh               # Recursive dylib relocation
│   └── make-dmg.sh                    # Create distributable DMG
└── project.yml                        # XcodeGen spec (generates .xcodeproj)
```
