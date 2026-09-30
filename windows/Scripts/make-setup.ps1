<#
.SYNOPSIS
    Package the assembled bundle into a Velopack release (update feed), then wrap its
    Setup.exe in the Fliks installer window (build\Setup\Fliks-Server-<version>-Setup.exe).

.PARAMETER Version
    SemVer2 version (release "4.3.0", dev "4.3.0-dev.42"). Velopack rejects anything else.

.PARAMETER CertBase64
    Base64 PFX for Authenticode signing. When empty, nothing is signed.

.PARAMETER CertPassword
    Password for the PFX.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Version,
    [string]$CertBase64 = '',
    [string]$CertPassword = ''
)

$ErrorActionPreference = 'Stop'
$winDir = Split-Path -Parent $PSScriptRoot
$build  = Join-Path $winDir 'build'
$bundle = Join-Path $build 'Bundle'
$out    = Join-Path $build 'Releases'

if (-not (Test-Path $bundle)) {
    throw "Bundle not found at $bundle. Run .\Scripts\build-app.ps1 first."
}
if (-not (Get-Command vpk -ErrorAction SilentlyContinue)) {
    throw 'vpk not found. Install it with: dotnet tool install -g vpk'
}

# The desktop client owns the default "win" channel of the same GitHub release.
$vpkArgs = @(
    'pack',
    '--packId', 'FliksServer',
    '--packVersion', $Version,
    '--packDir', $bundle,
    '--mainExe', 'Fliks Server.exe',
    '--packTitle', 'Fliks Server',
    '--packAuthors', 'Fliks',
    '--icon', (Join-Path $winDir 'Fliks.Tray\Resources\fliks.ico'),
    '--splashImage', (Join-Path $winDir 'Installer\splash.png'),
    '--channel', 'win-server',
    '--runtime', 'win-x64',
    '--noPortable',
    '--outputDir', $out
)

$pfx = $null
$signParams = $null
if ($CertBase64) {
    $pfx = Join-Path ([IO.Path]::GetTempPath()) 'fliks-sign.pfx'
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($CertBase64))
    $signParams = "/f `"$pfx`" /p `"$CertPassword`" /fd SHA256 /tr http://timestamp.digicert.com /td SHA256"
    $vpkArgs += @('--signParams', $signParams)
}

try {
    Write-Host "==> Packing FliksServer $Version"
    & vpk @vpkArgs
    if ($LASTEXITCODE -ne 0) { throw "vpk pack failed ($LASTEXITCODE)" }

    Write-Host '==> Building the installer'
    $setupOut = Join-Path $build 'Setup'
    $installed = 0L
    foreach ($f in [IO.Directory]::EnumerateFiles($bundle, '*', 'AllDirectories')) { $installed += ([IO.FileInfo]$f).Length }
    dotnet build (Join-Path $winDir 'Fliks.Setup\Fliks.Setup.csproj') -c Release -o $setupOut `
        -p:PackId=FliksServer "-p:MainExe=Fliks Server.exe" "-p:ProductTitle=Fliks Server" `
        -p:ServerPort=4848 -p:InstalledBytes=$installed `
        "-p:PayloadPath=$(Join-Path $out 'FliksServer-win-server-Setup.exe')" `
        "-p:SetupIcon=$(Join-Path $winDir 'Fliks.Tray\Resources\fliks.ico')" `
        "-p:AssemblyName=Fliks-Server-$Version-Setup"
    if ($LASTEXITCODE -ne 0) { throw "installer build failed ($LASTEXITCODE)" }

    if ($signParams) {
        $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' |
            Select-Object -Last 1
        & $signtool.FullName sign /f $pfx /p $CertPassword /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
            (Join-Path $setupOut "Fliks-Server-$Version-Setup.exe")
        if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
    }
}
finally {
    if ($pfx) { Remove-Item -Force $pfx -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "==> Installer ready: $(Join-Path $build "Setup\Fliks-Server-$Version-Setup.exe")"
