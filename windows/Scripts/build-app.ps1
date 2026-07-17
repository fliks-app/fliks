<#
.SYNOPSIS
    Build a self-contained Fliks Windows server bundle.

.DESCRIPTION
    Builds the Angular client + NestJS backend, publishes the .NET tray as a
    self-contained single-file exe, then assembles everything (tray + Node +
    PostgreSQL + FFmpeg + backend + client) under ..\build\Bundle. Feed that
    directory to make-installer.ps1.

.PARAMETER SkipWeb
    Reuse an existing client/backend build (skip npm/ng).
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

if (-not (Test-Path (Join-Path $vendored 'node\node.exe'))) {
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

    Write-Host '==> Building NestJS backend'
    Push-Location (Join-Path $repo 'backend')
    npm ci
    npm run build
    npm ci --omit=dev
    Pop-Location
}

Write-Host '==> Publishing tray (.NET, self-contained single-file)'
dotnet publish (Join-Path $winDir 'Fliks.Tray\Fliks.Tray.csproj') `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:TmdbApiKey="$env:TMDB_API_KEY" `
    -p:TvdbApiKey="$env:TVDB_API_KEY" `
    -o (Join-Path $build 'tray-publish')

# ── Assemble the bundle (layout mirrors AppPaths resolution) ──
Write-Host '==> Assembling bundle'
Copy-Item (Join-Path $build 'tray-publish\*') $bundle -Recurse -Force

New-Item -ItemType Directory -Force -Path (Join-Path $bundle 'node') | Out-Null
Copy-Item (Join-Path $vendored 'node\node.exe') (Join-Path $bundle 'node\node.exe')

Copy-Item (Join-Path $vendored 'pgsql')  (Join-Path $bundle 'pgsql')  -Recurse -Force
Copy-Item (Join-Path $vendored 'ffmpeg') (Join-Path $bundle 'ffmpeg') -Recurse -Force

New-Item -ItemType Directory -Force -Path (Join-Path $bundle 'backend') | Out-Null
Copy-Item (Join-Path $repo 'backend\dist')         (Join-Path $bundle 'backend\dist')         -Recurse -Force
Copy-Item (Join-Path $repo 'backend\node_modules') (Join-Path $bundle 'backend\node_modules') -Recurse -Force
Copy-Item (Join-Path $repo 'backend\package.json') (Join-Path $bundle 'backend\package.json')
if (Test-Path (Join-Path $repo 'backend\public')) {
    Copy-Item (Join-Path $repo 'backend\public') (Join-Path $bundle 'backend\public') -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $bundle 'client') | Out-Null
Copy-Item (Join-Path $repo 'client\dist\client\browser\*') (Join-Path $bundle 'client') -Recurse -Force

if ($Version) { Set-Content -Path (Join-Path $bundle 'VERSION') -Value $Version }

Write-Host ''
Write-Host "==> Bundle ready: $bundle"
