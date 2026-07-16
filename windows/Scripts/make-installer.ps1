<#
.SYNOPSIS
    Package the assembled bundle into a signed NSIS installer.

.DESCRIPTION
    Runs makensis over Installer\fliks.nsi with the build-app.ps1 bundle, then
    (if a code-signing cert is supplied) signs the installer with signtool.

.PARAMETER Version
    Display/version string embedded in the installer.

.PARAMETER CertBase64
    Base64 PFX for Authenticode signing. When empty, the installer is left
    unsigned (fine for local test builds; SmartScreen will warn on download).

.PARAMETER CertPassword
    Password for the PFX.
#>
[CmdletBinding()]
param(
    [string]$Version = '0.0.0',
    [string]$CertBase64 = '',
    [string]$CertPassword = ''
)

$ErrorActionPreference = 'Stop'
$winDir = Split-Path -Parent $PSScriptRoot
$build  = Join-Path $winDir 'build'
$bundle = Join-Path $build 'Bundle'
$nsi    = Join-Path $winDir 'Installer\fliks.nsi'
$outFile = Join-Path $build "Fliks-Setup-$Version.exe"

if (-not (Test-Path $bundle)) {
    throw "Bundle not found at $bundle. Run .\Scripts\build-app.ps1 first."
}

# choco installs makensis under Program Files but doesn't refresh the PATH
# for this session, so fall back to the standard install locations.
$cmd = Get-Command makensis -ErrorAction SilentlyContinue
$makensisPath = if ($cmd) { $cmd.Source } else { $null }
if (-not $makensisPath) {
    foreach ($p in @(
            "$env:ProgramFiles\NSIS\makensis.exe",
            "${env:ProgramFiles(x86)}\NSIS\makensis.exe")) {
        if (Test-Path $p) { $makensisPath = $p; break }
    }
}
if (-not $makensisPath) {
    throw 'makensis not found. Install NSIS (choco install nsis).'
}

Write-Host "==> Building installer ($Version)"
& $makensisPath `
    "/DVERSION=$Version" `
    "/DBUNDLE_DIR=$bundle" `
    "/DOUT_FILE=$outFile" `
    $nsi
if ($LASTEXITCODE -ne 0) { throw "makensis failed ($LASTEXITCODE)" }

# ── Optional Authenticode signing ──
if ($CertBase64) {
    Write-Host '==> Signing installer'
    $pfx = Join-Path ([IO.Path]::GetTempPath()) 'fliks-sign.pfx'
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($CertBase64))
    try {
        $signtool = Get-Command signtool -ErrorAction SilentlyContinue
        if (-not $signtool) {
            $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' `
                -ErrorAction SilentlyContinue | Select-Object -Last 1
        }
        if (-not $signtool) { throw 'signtool not found (install the Windows SDK).' }
        & $signtool.Source sign /f $pfx /p $CertPassword `
            /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $outFile
        if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
    }
    finally {
        Remove-Item -Force $pfx -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host "==> Installer ready: $outFile"
