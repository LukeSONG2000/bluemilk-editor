param([string]$OutputDirectory, [switch]$ForMsix)
$ErrorActionPreference = 'Stop'
$clientRoot = $PSScriptRoot
$output = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $clientRoot 'publish' }
if (Test-Path -LiteralPath $output) {
    if (!(Test-Path -LiteralPath $output -PathType Container) -or
        (Get-ChildItem -LiteralPath $output -Force | Select-Object -First 1)) {
        throw 'Publish output must be an empty directory. Choose a new directory to preserve prior artifacts.'
    }
}
$project = Join-Path $clientRoot 'Swgoh.Client.csproj'
$channelArguments = @()
if ($ForMsix) {
    $channelArguments += '-p:WindowsAppSdkUndockedRegFreeWinRTInitialize=false'
    $channelArguments += '-p:BlueMilkMsix=true'
}
# Channel-specific generated output must be rebuilt, not inherited from another
# publish or an older incremental build. Do not delete user-selected directories.
& dotnet build $project '-c' 'Release' '-t:Rebuild' @channelArguments
if ($LASTEXITCODE -ne 0) { throw 'Client release rebuild failed.' }
$publishArguments = @('publish', $project, '-c', 'Release', '--no-build', '-o', $output) + $channelArguments
& dotnet @publishArguments
if ($LASTEXITCODE -ne 0) { throw 'Client publish failed.' }
$updaterProject = Join-Path (Split-Path $clientRoot -Parent) 'updater/BlueMilk.Updater.csproj'
& dotnet publish $updaterProject '-c' 'Release' '-o' (Join-Path $output 'updater')
if ($LASTEXITCODE -ne 0) { throw 'Standalone updater publish failed.' }
$worker = Join-Path (Split-Path $clientRoot -Parent) 'dist/SWGoH-Runtime.exe'
if (!(Test-Path -LiteralPath $worker)) { throw 'Run build_desktop_host.py before packaging this client.' }
$runtimeDirectory = Join-Path $output 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Copy-Item -LiteralPath $worker -Destination (Join-Path $runtimeDirectory 'SWGoH-Runtime.exe')
$desktopRoot = Split-Path $clientRoot -Parent
$dataDirectory = Join-Path $output 'data'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $desktopRoot 'assets/names.json') -Destination (Join-Path $dataDirectory 'names.json')
# Mods are always distributed separately, including official packages.
if ((Get-ChildItem -LiteralPath $output -Recurse -File -Filter '*.bluemilk') -or
    (Test-Path -LiteralPath (Join-Path $output 'mods'))) {
    throw 'Editor distribution must not include Mod packages or a mods directory.'
}
Get-FileHash -LiteralPath (Join-Path $output 'BlueMilk.Editor.exe'), (Join-Path $output 'BlueMilk.Editor.dll'), (Join-Path $runtimeDirectory 'SWGoH-Runtime.exe')
