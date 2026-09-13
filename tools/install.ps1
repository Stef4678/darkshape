# Installs (or re-installs) Darkshape into the local Eagle plugin directory.
#
#   pwsh -File tools/install.ps1
#
# Only the runtime files are copied — tests, tools and node caches stay out
# of Eagle's plugin folder. Restart Eagle afterwards so it rescans Plugins/.

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$manifestPath = Join-Path $root 'manifest.json'

if (-not (Test-Path $manifestPath)) { throw "manifest.json not found at $manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$pluginsDir = Join-Path $env:APPDATA 'Eagle\Plugins'
if (-not (Test-Path $pluginsDir)) {
	throw "Eagle's plugin directory was not found: $pluginsDir"
}

$target = Join-Path $pluginsDir $manifest.id
$runtime = @('manifest.json', 'logo.png', 'index.html', 'css', 'js')

if (Test-Path $target) {
	Write-Host "removing previous install: $target"
	Remove-Item -Recurse -Force $target
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

foreach ($entry in $runtime) {
	$source = Join-Path $root $entry
	if (-not (Test-Path $source)) { throw "missing runtime file: $entry" }
	Copy-Item -Recurse -Force -Path $source -Destination $target
}

$copied = Get-ChildItem -Recurse -File $target
$size = ($copied | Measure-Object -Property Length -Sum).Sum

Write-Host ''
Write-Host "installed '$($manifest.name)' v$($manifest.version)" -ForegroundColor Green
Write-Host "  -> $target"
Write-Host "  $($copied.Count) files, $([math]::Round($size / 1KB, 1)) KB"
Write-Host ''
Write-Host 'Restart Eagle (or reload its plugin list) to pick up the plugin.'
