# Generates logo.png for the Darkshape plugin.
#
#   pwsh -File tools/make-logo.ps1
#
# Draws a rounded gradient tile with a bold silhouette mark. The mark is
# clipped to the tile so the corners stay clean, and kept deliberately
# simple so it still reads at the 24px size used in the title bar.

Add-Type -AssemblyName System.Drawing

$size = 256
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'logo.png'

$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# --- rounded-square tile -------------------------------------------------
$radius = 58
$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
$tile.AddArc(0, 0, $radius, $radius, 180, 90)
$tile.AddArc($size - $radius, 0, $radius, $radius, 270, 90)
$tile.AddArc($size - $radius, $size - $radius, $radius, $radius, 0, 90)
$tile.AddArc(0, $size - $radius, $radius, $radius, 90, 90)
$tile.CloseFigure()

$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
	(New-Object System.Drawing.Point(0, 0)),
	(New-Object System.Drawing.Point($size, $size)),
	[System.Drawing.Color]::FromArgb(255, 124, 92, 255),
	[System.Drawing.Color]::FromArgb(255, 34, 211, 238))
$g.FillPath($gradient, $tile)

# --- silhouette mark ----------------------------------------------------
# Everything below is clipped to the tile so nothing bleeds past a corner.
$g.SetClip($tile)

$ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 12, 13, 19))

# Head
$g.FillEllipse($ink, 98, 50, 60, 60)

# Shoulders: the upper half of a tall ellipse, so the chord lands exactly on
# the bottom edge of the tile and the shape reads as a bust.
$shoulders = New-Object System.Drawing.Drawing2D.GraphicsPath
$shoulders.AddArc(46, 122, 164, 268, 180, 180)
$shoulders.CloseFigure()
$g.FillPath($ink, $shoulders)

$g.ResetClip()

# --- soft top-left highlight -------------------------------------------
$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse(-70, -90, 240, 240)
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(52, 255, 255, 255)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
$g.SetClip($tile)
$g.FillPath($glowBrush, $glow)
$g.ResetClip()

# --- write ---------------------------------------------------------------
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()
$tile.Dispose()
$gradient.Dispose()
$ink.Dispose()
$shoulders.Dispose()
$glow.Dispose()
$glowBrush.Dispose()

$file = Get-Item $out
Write-Host "wrote $($file.FullName) ($($file.Length) bytes, ${size}x${size})"
