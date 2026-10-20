param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$CertificateThumbprint,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$SignTool
)
$ErrorActionPreference = 'Stop'
if ($CertificateThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Expected exact certificate thumbprint.' }
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$CertificateThumbprint"
if (!$certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) {
    throw 'Signing certificate lacks a private key or is outside its validity period.'
}
$eku = $certificate.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] }
if (!($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })) {
    throw 'Certificate does not permit code signing.'
}
$source = (Resolve-Path -LiteralPath $PackagePath).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($source)
try {
    if ($archive.GetEntry('AppxSignature.p7x')) { throw 'Input is already signed; refusing to replace its signature.' }
    $entry = $archive.GetEntry('AppxManifest.xml')
    if (!$entry) { throw 'MSIX manifest missing.' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally { $archive.Dispose() }
$identity = $manifest.Package.Identity
if ($identity.Name -ne 'BlueMilk.Editor' -or $identity.Publisher -ne $certificate.Subject) {
    throw 'Package identity or publisher does not match the signing certificate.'
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$destination = Join-Path $outputRoot ([IO.Path]::GetFileName($source))
if (Test-Path -LiteralPath $destination) { throw 'Output already exists; refusing to overwrite.' }
if (!$SignTool) {
    $SignTool = Join-Path $env:USERPROFILE '.nuget/packages/microsoft.windows.sdk.buildtools/10.0.28000.2705/bin/10.0.28000.0/x64/signtool.exe'
}
if (!(Test-Path -LiteralPath $SignTool)) { throw 'Supply a Windows SDK SignTool path.' }
Copy-Item -LiteralPath $source -Destination $destination
& $SignTool sign /fd SHA256 /s My /sha1 $CertificateThumbprint $destination
if ($LASTEXITCODE -ne 0) { throw 'MSIX signing failed; output must not be distributed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $destination
if (!$signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw 'Signed package did not contain the requested certificate.'
}
Add-Type -AssemblyName System.Security.Cryptography.Pkcs
$signedArchive = [IO.Compression.ZipFile]::OpenRead($destination)
try {
    $signatureStream = $signedArchive.GetEntry('AppxSignature.p7x').Open()
    $signatureBuffer = [IO.MemoryStream]::new()
    try { $signatureStream.CopyTo($signatureBuffer); $signatureBytes = $signatureBuffer.ToArray() }
    finally { $signatureStream.Dispose(); $signatureBuffer.Dispose() }
    if ([Text.Encoding]::ASCII.GetString($signatureBytes, 0, 4) -ne 'PKCX') { throw 'Invalid MSIX signature header.' }
    $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
    $cms.Decode([byte[]]$signatureBytes[4..($signatureBytes.Length - 1)])
    $cms.CheckSignature($true)
} finally { $signedArchive.Dispose() }
Export-Certificate -Cert $certificate -FilePath (Join-Path $outputRoot 'BlueMilk.Editor.cer') | Out-Null
@{
    version = [string]$identity.Version
    file = [IO.Path]::GetFileName($destination)
    sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    signed = $true
    cmsSignatureVerified = $true
    signatureStatus = [string]$signature.Status
    installVerified = $false
    publisher = $certificate.Subject
    certificateThumbprint = $certificate.Thumbprint
    certificateExpires = $certificate.NotAfter.ToUniversalTime().ToString('o')
    timestamped = $false
} | ConvertTo-Json | Set-Content -LiteralPath ($destination + '.json') -Encoding utf8NoBOM
Write-Output "Signed package: $destination"
Write-Output "Windows signature status: $($signature.Status). No certificate trust or installation was performed."
