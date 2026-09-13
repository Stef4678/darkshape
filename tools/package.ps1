# Packages the plugin as dist/Darkshape-<version>.eagleplugin.
#
#   pwsh -File tools/package.ps1
#
# The plugin files live at the project root next to README.md, so only
# $PluginFiles is ever packaged. Development scaffolding (tests/, tools/,
# assets/, .devtools/, .npm-cache/) is never shipped.
#
# This matters because Eagle's own "Pack Plugin" zips the ENTIRE folder it has
# registered for the plugin. With the plugin at the project root, that would
# sweep every dev artefact into the package — and Eagle's review criteria
# explicitly reject packages containing development output. Use this script for
# the package you submit or share.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot

# Exactly what ships as the Eagle plugin.
$PluginFiles = @('manifest.json', 'logo.png', 'index.html', 'css', 'js')

# ------------------------------------------------------------------ validate
foreach ($item in $PluginFiles) {
    if (-not (Test-Path (Join-Path $root $item))) {
        throw "missing plugin file: $item"
    }
}

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
Write-Output "plugin : $($manifest.name)  id=$($manifest.id)  v=$($manifest.version)"

# Eagle rejects plugins whose manifest id is not a UUID when they are installed
# from a package ("Your plugin ID format is incorrect..."), and it uses the id
# as the install folder name. Every store-installed plugin on this machine has
# a UUID id; only Eagle's own bundled plugins use short ids. A manually copied
# folder tolerates a short id, which is why this can go unnoticed until the
# first packaged install fails.
if ($manifest.id -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
    throw "manifest id '$($manifest.id)' is not a UUID - Eagle requires a UUID for plugins installed from a package."
}

# The version is also baked into the engine so diagnostics and the title bar
# still work when Eagle never delivers the plugin-create event. Keep the two in
# step or the diagnostics lie.
$engineSource = Get-Content (Join-Path $root 'js\engine.js') -Raw
$baked = [regex]::Match($engineSource, "VERSION:\s*'([^']+)'")
if (-not $baked.Success) {
    throw "js/engine.js does not declare VERSION"
}
if ($baked.Groups[1].Value -ne $manifest.version) {
    throw "version drift: manifest.json is $($manifest.version) but js/engine.js declares VERSION = $($baked.Groups[1].Value)"
}
Write-Output "version: manifest and js/engine.js agree ($($manifest.version))"

# ------------------------------------------------------- folder hygiene check
function Get-TreeSize($path) {
    if (-not (Test-Path $path)) { return 0 }
    $sum = (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 }
    return $sum
}

$extra = @()
Get-ChildItem $root -Force | Where-Object {
    $PluginFiles -notcontains $_.Name -and $_.Name -ne 'README.md'
} | ForEach-Object {
    $size = if ($_.PSIsContainer) { Get-TreeSize $_.FullName } else { $_.Length }
    $extra += [pscustomobject]@{ Name = $_.Name; Bytes = $size }
}

$pluginBytes = 0
foreach ($item in $PluginFiles) { $pluginBytes += Get-TreeSize (Join-Path $root $item) }
$extraBytes = ($extra | Measure-Object -Property Bytes -Sum).Sum
if ($null -eq $extraBytes) { $extraBytes = 0 }

Write-Output ("this script packages : {0,8:N2} MB (uncompressed, {1} item(s))" -f ($pluginBytes / 1MB), $PluginFiles.Count)
Write-Output ("Eagle's Pack Plugin  : {0,8:N2} MB (zips the whole folder)" -f (($pluginBytes + $extraBytes) / 1MB))
if ($extra.Count) {
    Write-Output "             extra   :"
    $extra | Sort-Object Bytes -Descending | ForEach-Object {
        Write-Output ("                       {0,8:N2} MB  {1}" -f ($_.Bytes / 1MB), $_.Name)
    }
    Write-Output "  -> use this script for the package you submit; Eagle's own"
    Write-Output "     Pack Plugin would include the items above."
}

# A package must never contain a nested package or archive.
$nested = Get-ChildItem $root -Recurse -File -Include *.eagleplugin, *.zip -ErrorAction SilentlyContinue |
    Where-Object { $PluginFiles -contains $_.Directory.Name -or $_.Directory.FullName -eq $root }
if ($nested) {
    Write-Output "  warning: an archive sits inside the plugin folder; Eagle's pack would nest it:"
    $nested | ForEach-Object { Write-Output ("             {0}" -f $_.Name) }
}

# ------------------------------------------------------------------- staging
$stage = Join-Path $env:TEMP ("darkshape-package-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($item in $PluginFiles) {
    Copy-Item -Path (Join-Path $root $item) -Destination $stage -Recurse -Force
}

# ------------------------------------------------------------------ package
$distDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$package = Join-Path $distDir ("Darkshape-{0}.eagleplugin" -f $manifest.version)
if (Test-Path $package) { Remove-Item $package -Force }

# Entry names must use forward slashes, which is what Eagle's own Pack Plugin
# produces. ZipFile::CreateFromDirectory emits backslashes on Windows, which
# other extractors can mishandle.
$zip = [System.IO.Compression.ZipFile]::Open($package, 'Create')
try {
    foreach ($file in Get-ChildItem $stage -Recurse -File | Sort-Object FullName) {
        $rel = $file.FullName.Substring($stage.Length + 1) -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $file.FullName, $rel,
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $zip.Dispose()
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($package)
$entryNames = $zip.Entries | ForEach-Object { $_.FullName }
$zip.Dispose()

Write-Output "package: $package  ($((Get-Item $package).Length) bytes, $($entryNames.Count) entries)"
$entryNames | Sort-Object | ForEach-Object { Write-Output "   $_" }

if ($entryNames -match '\\') { throw "package contains backslash entry names" }
# The manifest has to sit at the root, not inside a wrapper folder.
if ($entryNames -notcontains 'manifest.json') { throw "manifest.json is not at the root of the package" }
# A packaged plugin must never contain tooling.
foreach ($bad in @('tools/', 'tests/', 'assets/', 'dist/', 'README.md', 'node_modules/', '.devtools/')) {
    if ($entryNames -match [regex]::Escape($bad)) { throw "package unexpectedly contains $bad" }
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Output "done."
