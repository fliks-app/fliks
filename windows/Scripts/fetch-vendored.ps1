<#
.SYNOPSIS
    Fetch the Windows x64 binaries bundled into the Fliks server app.

.DESCRIPTION
    Downloads Node.js, PostgreSQL (EDB binaries) and FFmpeg (BtbN gpl full
    build — one binary covers QSV + AMF + NVENC + OpenCL) into
    ..\Vendored\{node,pgsql,ffmpeg}. Idempotent: skips components already
    present.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendored = Join-Path $root 'Vendored'
New-Item -ItemType Directory -Force -Path $vendored | Out-Null

# ── Versions ──
$NodeVersion = '24.2.0'
# EDB "binaries" zip (no installer) — verify the build suffix at
# https://www.enterprisedb.com/download-postgresql-binaries
$PgVersion = '18.0-1'
# n8.1 stable release branch (NOT master). 8.1 carries the native scale_d3d11
# filter (zero-copy AMD scale, dormant until a GPU accepts it). 8.1's scale_cuda
# has a green-frame bug on non-scaling format conversion (p010→nv12 with no
# resize); we sidestep it in the encoder filter graph (scale_cuda keeps the
# native format, the encoder owns the output bit depth) so this pin is safe.
# Note: 8.x links a newer NVENC API — NVENC needs an NVIDIA driver >= 570; older
# drivers fall back to CPU. One binary covers QSV + AMF + NVENC + OpenCL.
$FfmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip'

function Get-Archive([string]$url, [string]$dest) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'archive.zip'
    Write-Host "    [fetch] $url"
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item -Recurse -Force $tmp
}

Write-Host "==> Fetching vendored binaries to $vendored"

# ── Node.js ──
$nodeExe = Join-Path $vendored 'node\node.exe'
if (Test-Path $nodeExe) {
    Write-Host '    [skip] Node.js already present'
} else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
    Get-Archive "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $tmp
    New-Item -ItemType Directory -Force -Path (Join-Path $vendored 'node') | Out-Null
    Copy-Item (Join-Path $tmp "node-v$NodeVersion-win-x64\node.exe") (Join-Path $vendored 'node\node.exe')
    Remove-Item -Recurse -Force $tmp
    Write-Host "    [done] Node.js v$NodeVersion"
}

# ── PostgreSQL (EDB binaries) ──
if (Test-Path (Join-Path $vendored 'pgsql\bin\postgres.exe')) {
    Write-Host '    [skip] PostgreSQL already present'
} else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
    Get-Archive "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" $tmp
    # Archive root is `pgsql/`.
    Copy-Item (Join-Path $tmp 'pgsql') (Join-Path $vendored 'pgsql') -Recurse -Force
    Remove-Item -Recurse -Force $tmp
    Write-Host "    [done] PostgreSQL $PgVersion"
}

# ── FFmpeg (BtbN gpl static) ──
if (Test-Path (Join-Path $vendored 'ffmpeg\bin\ffmpeg.exe')) {
    Write-Host '    [skip] FFmpeg already present'
} else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
    Get-Archive $FfmpegUrl $tmp
    $ffBin = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'bin' }
    New-Item -ItemType Directory -Force -Path (Join-Path $vendored 'ffmpeg\bin') | Out-Null
    Copy-Item (Join-Path $ffBin 'ffmpeg.exe') (Join-Path $vendored 'ffmpeg\bin\ffmpeg.exe')
    Copy-Item (Join-Path $ffBin 'ffprobe.exe') (Join-Path $vendored 'ffmpeg\bin\ffprobe.exe')
    Remove-Item -Recurse -Force $tmp
    Write-Host '    [done] FFmpeg (gpl)'
}

Write-Host ''
Write-Host "==> Vendored binaries ready in $vendored"
& (Join-Path $vendored 'node\node.exe') --version
& (Join-Path $vendored 'pgsql\bin\postgres.exe') --version
& (Join-Path $vendored 'ffmpeg\bin\ffmpeg.exe') -version | Select-Object -First 1
