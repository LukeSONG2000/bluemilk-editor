param([string]$AssetDirectory = (Join-Path $PSScriptRoot '../src/client/Assets'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = [IO.Path]::GetFullPath($AssetDirectory)
$bytes = [IO.File]::ReadAllBytes((Join-Path $root 'account-portrait.ico'))
$sourceFrame = $null
for ($index=0; $index -lt [BitConverter]::ToUInt16($bytes,4); $index++) {
    $entry = 6 + 16 * $index
    if ($bytes[$entry] -eq 0 -and $bytes[$entry+1] -eq 0) {
        $length = [BitConverter]::ToUInt32($bytes,$entry+8)
        $offset = [BitConverter]::ToUInt32($bytes,$entry+12)
        $sourceFrame = [IO.MemoryStream]::new([byte[]]$bytes[$offset..($offset+$length-1)])
        break
    }
}
if ($null -eq $sourceFrame) { throw 'Missing 256px source frame.' }
$source = [Drawing.Bitmap]::FromStream($sourceFrame)
if ($source.Width -ne 256 -or $source.Height -ne 256) { throw 'Expected the original 256px dual-milk icon.' }
$cup = [Drawing.Bitmap]::new(80, 148, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
# Extract the foreground left cup. Follow its stepped shoulder so the taller
# bottle behind it does not remain in the transparent upper-right corner.
for ($y = 94; $y -lt 242; $y++) {
    $right = if ($y -lt 98) { 110 } elseif ($y -lt 102) { 116 } elseif ($y -lt 106) { 120 } elseif ($y -lt 110) { 124 } else { 126 }
    for ($x = 46; $x -lt $right; $x++) { $cup.SetPixel($x - 46, $y - 94, $source.GetPixel($x, $y)) }
}
$sizes = @(16,20,24,32,40,48,64,96,128,256)
$frames = @()
foreach ($size in $sizes) {
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
    $height = [int][Math]::Round($size * 0.875)
    $width = [int][Math]::Round($height * $cup.Width / $cup.Height)
    $rectangle = [Drawing.Rectangle]::new([int][Math]::Floor(($size-$width)/2),[int][Math]::Floor(($size-$height)/2),$width,$height)
    $graphics.DrawImage($cup,$rectangle,0,0,$cup.Width,$cup.Height,[Drawing.GraphicsUnit]::Pixel)
    $graphics.Dispose()
    $memory = [IO.MemoryStream]::new()
    $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
    $frames += ,$memory.ToArray()
    if ($size -eq 256) { $bitmap.Save((Join-Path $root 'mod-package.png'),[Drawing.Imaging.ImageFormat]::Png) }
    $memory.Dispose(); $bitmap.Dispose()
}
$stream = [IO.File]::Create((Join-Path $root 'mod-package.ico'))
$writer = [IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i=0; $i -lt $sizes.Count; $i++) {
    $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
    $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
$writer.Dispose(); $cup.Dispose(); $source.Dispose(); $sourceFrame.Dispose()
