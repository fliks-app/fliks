<#
.SYNOPSIS
    Fetch the Windows x64 binaries bundled into the Fliks server app.

.DESCRIPTION
    Downloads PostgreSQL (EDB binaries, sha256-checked) into ..\Vendored\pgsql.
    ffmpeg and the other media tools come from the engine's tools pack
    (engine.lock), fetched by build-app.ps1. Idempotent: skips a component
    already present.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendored = Join-Path $root 'Vendored'
New-Item -ItemType Directory -Force -Path $vendored | Out-Null

# ── Versions ──
# EDB "binaries" zip (no installer) — verify the build suffix at
# https://www.enterprisedb.com/download-postgresql-binaries
$PgVersion = '18.0-1'
# sha256 of that zip (EDB publishes none; computed from the download over HTTPS).
$PgSha256 = '4a1ea6e6ecbde1747103c7b5bc0674cc415b9aa8ef7b7bad3a4ee38c37c051b1'

$ProgressPreference = 'SilentlyContinue'

# tar.exe (bsdtar, in Windows 10+) extracts zips far faster than Expand-Archive.
function Get-Archive([string]$url, [string]$sha256, [string]$dest, [string[]]$Exclude = @()) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $tmp, $dest | Out-Null
    $zip = Join-Path $tmp 'archive.zip'
    Write-Host "    [fetch] $url"
    Invoke-WebRequest -Uri $url -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sha256) { throw "sha256 mismatch for $url" }
    tar -xf $zip -C $dest ($Exclude | ForEach-Object { "--exclude=$_" })
    if ($LASTEXITCODE -ne 0) { throw "tar failed on $url ($LASTEXITCODE)" }
    Remove-Item -Recurse -Force $tmp
}

Write-Host "==> Fetching vendored binaries to $vendored"

# ── PostgreSQL (EDB binaries) ──
if (Test-Path (Join-Path $vendored 'pgsql\bin\postgres.exe')) {
    Write-Host '    [skip] PostgreSQL already present'
} else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
    # Archive root is `pgsql/`. pgAdmin alone is ~19k files / 700 MB the server never runs.
    Get-Archive "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" $PgSha256 $tmp `
        -Exclude 'pgsql/pgAdmin*', 'pgsql/doc', 'pgsql/include', 'pgsql/StackBuilder'
    Copy-Item (Join-Path $tmp 'pgsql') (Join-Path $vendored 'pgsql') -Recurse -Force
    Remove-Item -Recurse -Force $tmp
    Write-Host "    [done] PostgreSQL $PgVersion"
}

# ── VC++ 2015-2022 runtime, app-local next to the exes that link it ──
# The PG18 EDB binaries are built with a recent VS toolset; on a host
# whose system MSVCP140.dll is older they crash (0xC0000005 ACCESS_VIOLATION —
# seen at initdb). Windows searches the exe's own directory before System32, so
# bundling the runtime beside each exe makes it load the correct version.
$vcDlls = @(
    'MSVCP140.dll', 'MSVCP140_1.dll', 'MSVCP140_2.dll', 'MSVCP140_atomic_wait.dll',
    'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'CONCRT140.dll'
)
foreach ($dll in $vcDlls) {
    $src = Join-Path $env:SystemRoot "System32\$dll"
    $dst = Join-Path $vendored "pgsql\bin\$dll"
    if ((Test-Path $src) -and -not (Test-Path $dst)) { Copy-Item $src $dst -Force }
}
$mp = Join-Path $vendored 'pgsql\bin\MSVCP140.dll'
if (Test-Path $mp) {
    Write-Host "    [done] VC++ runtime bundled ($((Get-Item $mp).VersionInfo.FileVersion))"
} else {
    Write-Warning 'MSVCP140.dll not bundled; postgres may crash on hosts with an old VC++ runtime'
}

Write-Host ''
Write-Host "==> Vendored binaries ready in $vendored"
& (Join-Path $vendored 'pgsql\bin\postgres.exe') --version
