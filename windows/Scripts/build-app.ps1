<#
.SYNOPSIS
    Build a self-contained Fliks Windows server bundle.

.DESCRIPTION
    Builds the Angular client and fliks-server, publishes the .NET tray as a
    self-contained single-file exe, then assembles everything (tray + engine +
    server + PostgreSQL + FFmpeg + client) under ..\build\Bundle. Feed that
    directory to make-installer.ps1.

.PARAMETER SkipWeb
    Reuse an existing client build (skip npm/ng).
#>
[CmdletBinding()]
param(
    [switch]$SkipWeb,
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$winDir  = Split-Path -Parent $PSScriptRoot
$repo    = Split-Path -Parent $winDir
$vendored = Join-Path $winDir 'Vendored'
$build   = Join-Path $winDir 'build'
$bundle  = Join-Path $build 'Bundle'

if (-not (Test-Path (Join-Path $vendored 'pgsql\bin\postgres.exe'))) {
    throw 'Vendored binaries missing. Run .\Scripts\fetch-vendored.ps1 first.'
}

Write-Host '==> Cleaning bundle dir'
Remove-Item -Recurse -Force $bundle -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $bundle | Out-Null

if (-not $SkipWeb) {
    Write-Host '==> Building Angular client'
    Push-Location (Join-Path $repo 'client')
    npm ci
    npx ng build --configuration=production
    Pop-Location
}

Write-Host '==> Publishing tray (.NET, self-contained single-file)'
dotnet publish (Join-Path $winDir 'Fliks.Tray\Fliks.Tray.csproj') `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:TmdbApiKey="$env:TMDB_API_KEY" `
    -p:TvdbApiKey="$env:TVDB_API_KEY" `
    -o (Join-Path $build 'tray-publish')

# Multi-threaded: the client and pgsql trees are thousands of files.
function Copy-Tree([string]$From, [string]$To, [string[]]$Skip = @()) {
    robocopy $From $To /E /MT:16 /NFL /NDL /NJH /NJS /NP @Skip | Out-Null
    # robocopy exit codes below 8 all mean success.
    if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed ($LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}

# ── Assemble the bundle (layout mirrors AppPaths resolution) ──
Write-Host '==> Assembling bundle'
Copy-Item (Join-Path $build 'tray-publish\*') $bundle -Recurse -Force

$bin = Join-Path $bundle 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
# The Rust exes link the VC++ runtime too: the app-local copy fetch-vendored.ps1 put beside postgres.
Get-ChildItem (Join-Path $vendored 'pgsql\bin') -Filter '*140*.dll' | Copy-Item -Destination $bin

# fliks-engine (supervisor, pinned in engine.lock).
$lock = @{}
Get-Content (Join-Path $repo 'engine.lock') | Where-Object { $_ -match '^\w+=' } | ForEach-Object { $k, $v = $_ -split '=', 2; $lock[$k] = $v }
if (-not $lock['sha256_windows_x64']) { throw 'engine.lock has no sha256_windows_x64 (run scripts/bump-engine.sh).' }
$engine = Join-Path $bin 'fliks-engine.exe'
Invoke-WebRequest "https://github.com/fliks-app/engine/releases/download/v$($lock['version'])/fliks-engine-windows-x64.exe" -OutFile $engine
if ((Get-FileHash $engine -Algorithm SHA256).Hash -ne $lock['sha256_windows_x64']) { throw 'fliks-engine sha256 mismatch' }

# fliks-server (Rust) sits beside the engine.
Push-Location (Join-Path $repo 'server')
try { cargo build --release -p fliks-server; if ($LASTEXITCODE) { throw 'cargo build failed' } } finally { Pop-Location }
Copy-Item (Join-Path $repo 'server\target\release\fliks-server.exe') (Join-Path $bin 'fliks-server.exe')

# Setup's extraction time follows the file count (each one is scanned by the antivirus), so
# what the server never loads stays out: message translations, sourcemaps, typings, docs.
Copy-Tree (Join-Path $vendored 'pgsql')  (Join-Path $bundle 'pgsql') @('/XD', (Join-Path $vendored 'pgsql\share\locale'))
Copy-Tree (Join-Path $vendored 'ffmpeg') (Join-Path $bundle 'ffmpeg')
Copy-Tree (Join-Path $repo 'server\public') (Join-Path $bundle 'cast')

New-Item -ItemType Directory -Force -Path (Join-Path $bundle 'client') | Out-Null
Copy-Tree (Join-Path $repo 'client\dist\client\browser') (Join-Path $bundle 'client')

foreach ($f in 'bin\fliks-engine.exe', 'bin\fliks-server.exe', 'cast\cast-receiver.html', 'client\index.html') {
    if (-not (Test-Path (Join-Path $bundle $f))) { throw "bundle is missing $f" }
}

if ($Version) { Set-Content -Path (Join-Path $bundle 'VERSION') -Value $Version }

Write-Host ''
Write-Host "==> Bundle ready: $bundle"
