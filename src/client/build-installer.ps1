param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$Compiler = (Join-Path $env:LOCALAPPDATA 'Programs/Inno Setup 6/ISCC.exe')
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw 'Supply -Compiler with Inno Setup ISCC.exe.' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
[xml]$versions = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Version.props')
$version = [string]$versions.Project.PropertyGroup.Version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected major.minor.patch version.' }
$package = Join-Path $outputRoot "BlueMilk-Editor-$version-Setup.exe"
if (Test-Path -LiteralPath $package) { throw 'Installer already exists; preserve prior evidence with a new output directory.' }
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$stage = Join-Path $outputRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
# Unpackaged WinUI needs its normal activation manifest, never -ForMsix.
& (Join-Path $PSScriptRoot 'build.ps1') -OutputDirectory $stage
if ($LASTEXITCODE -ne 0) { throw 'Fresh client publish failed.' }
foreach ($required in @('BlueMilk.Editor.exe','BlueMilk.Editor.dll','BlueMilk.Editor.pri',
        'App.xbf','runtime/SWGoH-Runtime.exe','packages/agent-cli/bluemilk.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw "Missing package file: $required" }
}
& $Compiler "/DPublishDir=$stage" "/DOutputDir=$outputRoot" "/DAppVersion=$version" (Join-Path $PSScriptRoot 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
Get-FileHash -LiteralPath $package
