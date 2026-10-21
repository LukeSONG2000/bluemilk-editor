$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$payload = Join-Path $repo 'npm/bluemilk/payload'
New-Item -ItemType Directory -Force $payload | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'src/dist/bluemilk.exe') -Destination (Join-Path $payload 'bluemilk.exe')
& npm.cmd pack (Join-Path $repo 'npm/bluemilk') --pack-destination (Join-Path $repo 'logs') --json
if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
