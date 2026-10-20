param([string]$OutputDirectory, [switch]$ForMsix)
$ErrorActionPreference = 'Stop'
$clientRoot = $PSScriptRoot
$output = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $clientRoot 'publish' }
$publishArguments = @('publish', (Join-Path $clientRoot 'Swgoh.Client.csproj'), '-c', 'Release', '-o', $output)
if ($ForMsix) {
    $publishArguments += '-p:WindowsAppSdkUndockedRegFreeWinRTInitialize=false'
    $publishArguments += '-p:BlueMilkMsix=true'
}
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
