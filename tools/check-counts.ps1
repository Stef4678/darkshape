# Checks that the assertion count quoted in README.md matches what the two
# suites actually report.
#
#   pwsh -File tools/check-counts.ps1          # fail on a mismatch
#   pwsh -File tools/check-counts.ps1 -Fix     # rewrite the README instead
#
# A test count only ever goes stale in one direction: every test anyone adds
# makes the prose quietly wrong, and nobody re-reads a number they have already
# seen. This is the same class of problem as a version number in a commit
# message - a fact written down where nothing keeps it honest.
#
# tools/package.ps1 runs this before building, so a release cannot ship a
# package whose README misstates what the suite covers.

param(
    [switch]$Fix
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

function Get-SuiteResult($relativePath) {
    $path = Join-Path $root $relativePath
    if (-not (Test-Path $path)) { throw "missing suite: $relativePath" }

    $output = & node $path 2>&1
    $exit = $LASTEXITCODE
    $text = $output -join "`n"

    $match = [regex]::Match($text, '(\d+) passed, (\d+) failed')
    if (-not $match.Success) {
        throw "could not read a result from $relativePath - it did not finish cleanly"
    }

    return [pscustomobject]@{
        Path   = $relativePath
        Passed = [int]$match.Groups[1].Value
        Failed = [int]$match.Groups[2].Value
        Exit   = $exit
    }
}

$engine = Get-SuiteResult 'tests\engine.test.js'
$ui = Get-SuiteResult 'tests\dom-smoke.js'

foreach ($s in @($engine, $ui)) {
    Write-Output ("{0,-24} {1,4} passed  {2} failed" -f $s.Path, $s.Passed, $s.Failed)
    if ($s.Failed -gt 0 -or $s.Exit -ne 0) {
        throw "$($s.Path) is failing - fix that before worrying about the README"
    }
}

$total = $engine.Passed + $ui.Passed

$readmePath = Join-Path $root 'README.md'
$readme = Get-Content $readmePath -Raw
$claim = [regex]::Match($readme, '(\d+) assertions in total')
if (-not $claim.Success) {
    throw "README.md no longer states an assertion count - either restore the line or drop this check"
}
$claimed = [int]$claim.Groups[1].Value

Write-Output ""
Write-Output "suites report : $total"
Write-Output "README claims : $claimed"

if ($claimed -eq $total) {
    Write-Output "counts agree."
    exit 0
}

if ($Fix) {
    $updated = $readme -replace '(\d+) assertions in total', "$total assertions in total"
    Set-Content -Path $readmePath -Value $updated -NoNewline
    Write-Output "README updated: $claimed -> $total"
    exit 0
}

Write-Output ""
Write-Output "MISMATCH: README.md claims $claimed assertions but the suites report $total."
Write-Output "Run:  pwsh -File tools/check-counts.ps1 -Fix"
exit 1
