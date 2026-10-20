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
$worker = Join-Path (Split-Path $clientRoot -Parent) 'dist/SWGoH-Runtime.exe'
if (!(Test-Path -LiteralPath $worker)) { throw 'Run build_desktop_host.py before packaging this client.' }
$runtimeDirectory = Join-Path $output 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Copy-Item -LiteralPath $worker -Destination (Join-Path $runtimeDirectory 'SWGoH-Runtime.exe')
$desktopRoot = Split-Path $clientRoot -Parent
$dataDirectory = Join-Path $output 'data'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $desktopRoot 'assets/names.json') -Destination (Join-Path $dataDirectory 'names.json')
$agentCli = Join-Path $desktopRoot 'dist/bluemilk.exe'
if (Test-Path -LiteralPath $agentCli) {
    $agentPackage = Join-Path $output 'packages/agent-cli'
    New-Item -ItemType Directory -Force -Path $agentPackage | Out-Null
    Copy-Item -LiteralPath $agentCli -Destination (Join-Path $agentPackage 'bluemilk.exe')
    Copy-Item -LiteralPath (Join-Path $desktopRoot 'CLI说明.txt') -Destination (Join-Path $agentPackage 'CLI说明.txt')
    @{
        schemaVersion = 1
        exeSha256 = (Get-FileHash -LiteralPath (Join-Path $agentPackage 'bluemilk.exe')).Hash.ToLowerInvariant()
        guideSha256 = (Get-FileHash -LiteralPath (Join-Path $agentPackage 'CLI说明.txt')).Hash.ToLowerInvariant()
    } | ConvertTo-Json | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $agentPackage 'manifest.json')
}
Get-FileHash -LiteralPath (Join-Path $output 'BlueMilk.Editor.exe'), (Join-Path $output 'BlueMilk.Editor.dll'), (Join-Path $runtimeDirectory 'SWGoH-Runtime.exe')
