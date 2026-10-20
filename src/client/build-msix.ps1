param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$Publisher = 'CN=BlueMilk Editor',
    [string]$MakeAppx
)
$ErrorActionPreference = 'Stop'
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
[xml]$versions = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Version.props')
$version = [string]$versions.Project.PropertyGroup.BlueMilkPackageVersion
if ($version -notmatch '^\d+\.\d+\.\d+\.0$') { throw 'MSIX version must have four parts with final zero.' }
$parsedVersion = [Version]$version
if (@($parsedVersion.Major, $parsedVersion.Minor, $parsedVersion.Build) | Where-Object { $_ -gt 65535 }) {
    throw 'MSIX version component exceeds 65535.'
}
if ([string]$versions.Project.PropertyGroup.Version -ne "$($parsedVersion.Major).$($parsedVersion.Minor).$($parsedVersion.Build)") {
    throw 'Application and MSIX versions differ.'
}
if (!$MakeAppx) {
    $sdkRoot = Join-Path $env:USERPROFILE '.nuget/packages/microsoft.windows.sdk.buildtools/10.0.28000.2705'
    $MakeAppx = Join-Path $sdkRoot 'bin/10.0.28000.0/x64/makeappx.exe'
}
if (!(Test-Path -LiteralPath $MakeAppx -PathType Leaf)) { throw 'Supply -MakeAppx with the Windows SDK x64 makeappx.exe path.' }
$package = Join-Path $outputRoot "BlueMilk.Editor_${version}_x64.msix"
if (Test-Path -LiteralPath $package) { throw 'Package already exists; use a new output directory to preserve previous evidence.' }
$stage = Join-Path $outputRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
& (Join-Path $PSScriptRoot 'build.ps1') -OutputDirectory $stage -ForMsix
if ($LASTEXITCODE -ne 0) { throw 'Fresh client publish failed.' }
foreach ($required in @('BlueMilk.Editor.exe', 'BlueMilk.Editor.dll', 'BlueMilk.Editor.pri', 'App.xbf', 'runtime/SWGoH-Runtime.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw "Missing required package file: $required" }
}
if (Test-Path -LiteralPath (Join-Path $stage 'Swgoh.Client.exe')) { throw 'Stale executable in fresh staging directory.' }

# Resize the approved icon mechanically for Windows package tile requirements.
Add-Type -AssemblyName System.Drawing
$sourceIcon = [Drawing.Icon]::new((Join-Path $PSScriptRoot 'Assets/account-portrait.ico'), 256, 256)
$sourceBitmap = $sourceIcon.ToBitmap()
try {
    foreach ($size in @(44, 50, 150)) {
        $bitmap = [Drawing.Bitmap]::new($size, $size)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
            $graphics.DrawImage($sourceBitmap, 0, 0, $size, $size)
            $bitmap.Save((Join-Path $stage "Assets/PackageLogo$size.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $sourceBitmap.Dispose(); $sourceIcon.Dispose() }
$publisherXml = [Security.SecurityElement]::Escape($Publisher)
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap rescap desktop6">
 <Identity Name="BlueMilk.Editor" Publisher="$publisherXml" Version="$version" ProcessorArchitecture="x64" />
 <Properties>
  <DisplayName>BlueMilk Editor</DisplayName><PublisherDisplayName>BlueMilk Editor</PublisherDisplayName>
  <Logo>Assets\PackageLogo50.png</Logo>
  <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
 </Properties>
 <Resources><Resource Language="en-us"/><Resource Language="zh-cn"/></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
 <Applications>
  <Application Id="Editor" Executable="BlueMilk.Editor.exe" EntryPoint="Windows.FullTrustApplication">
   <uap:VisualElements DisplayName="BlueMilk Editor" Description="BlueMilk Editor"
    BackgroundColor="transparent" Square150x150Logo="Assets\PackageLogo150.png" Square44x44Logo="Assets\PackageLogo44.png"/>
  </Application>
 </Applications>
 <Capabilities><rescap:Capability Name="runFullTrust"/><rescap:Capability Name="unvirtualizedResources"/></Capabilities>
</Package>
"@
# Packaged WinRT activation uses package registrations, not only the executable's
# reg-free manifest. Take registrations from the exact SDK resolved by this build.
$sdkManifestPath = & dotnet msbuild (Join-Path $PSScriptRoot 'Swgoh.Client.csproj') -p:Configuration=Release -target:GetExtractMicrosoftWindowsAppSDKMsixFilesInputs -getProperty:WindowsAppSDKAppxManifest
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Windows App SDK manifest.' }
$sdkManifestPath = ($sdkManifestPath -join "`n").Trim()
if (!(Test-Path -LiteralPath $sdkManifestPath -PathType Leaf)) { throw 'Resolved Windows App SDK manifest is missing.' }
[xml]$sdkManifest = Get-Content -Raw -LiteralPath $sdkManifestPath
[xml]$packageManifest = $manifest
$namespace = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10'
$extensions = $packageManifest.CreateElement('Extensions', $namespace)
$registrations = 0
foreach ($extension in $sdkManifest.Package.Extensions.Extension) {
    if ($extension.Category -notin @('windows.activatableClass.inProcessServer', 'windows.activatableClass.proxyStub')) { continue }
    $server = if ($extension.InProcessServer) { $extension.InProcessServer } else { $extension.ProxyStub }
    $dll = [string]$server.Path
    if (!$dll -or [IO.Path]::GetFileName($dll) -ne $dll -or
        !(Test-Path -LiteralPath (Join-Path $stage $dll) -PathType Leaf)) {
        throw "Missing or invalid SDK activation payload: $dll"
    }
    $extensions.AppendChild($packageManifest.ImportNode($extension, $true)) | Out-Null
    $registrations++
}
if ($registrations -eq 0 -or !$extensions.InnerXml.Contains('Microsoft.UI.Xaml.Application')) {
    throw 'SDK registrations do not contain WinUI Application activation.'
}
$packageManifest.Package.AppendChild($extensions) | Out-Null
$packageManifest.Save((Join-Path $stage 'AppxManifest.xml'))
$makePri = Join-Path (Split-Path $MakeAppx -Parent) 'makepri.exe'
if (!(Test-Path -LiteralPath $makePri -PathType Leaf)) { throw 'Windows SDK makepri.exe is missing.' }
$priConfig = Join-Path $outputRoot 'priconfig.xml'
& $makePri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o
if ($LASTEXITCODE -ne 0) { throw 'PRI configuration generation failed.' }
[xml]$priSettings = Get-Content -Raw -LiteralPath $priConfig
# Ship a single self-contained resource index instead of generating language
# resource packages which this installer does not deploy.
$priSettings.resources.RemoveChild($priSettings.resources.packaging) | Out-Null
$priInputs = Join-Path $outputRoot 'pri.resfiles'
Get-ChildItem -LiteralPath $stage -Filter '*.pri' -File | ForEach-Object Name |
    Set-Content -LiteralPath $priInputs -Encoding utf8NoBOM
$priSettings.resources.index.SetAttribute('startIndexAt', $priInputs)
foreach ($indexer in @($priSettings.resources.index.'indexer-config')) {
    $priSettings.resources.index.RemoveChild($indexer) | Out-Null
}
foreach ($type in @('PRI', 'RESFILES')) {
    $indexer = $priSettings.CreateElement('indexer-config')
    $indexer.SetAttribute('type', $type)
    if ($type -eq 'RESFILES') { $indexer.SetAttribute('qualifierDelimiter', '.') }
    $priSettings.resources.index.AppendChild($indexer) | Out-Null
}
$priSettings.Save($priConfig)
& $makePri new /pr $stage /cf $priConfig /of (Join-Path $stage 'resources.pri') /in BlueMilk.Editor /o
if ($LASTEXITCODE -ne 0) { throw 'Package resource index generation failed.' }
& $MakeAppx pack /d $stage /p $package /o
if ($LASTEXITCODE -ne 0) { throw 'MakeAppx validation/pack failed.' }
@{
    version = $version
    file = [IO.Path]::GetFileName($package)
    sha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    signed = $false
    installVerified = $false
    publisher = $Publisher
} | ConvertTo-Json | Set-Content -LiteralPath ($package + '.json') -Encoding utf8NoBOM
Write-Output "Unsigned MSIX created: $package"
