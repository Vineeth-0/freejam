[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "hooks\post-merge"
$destination = Join-Path $repoRoot ".git\hooks\post-merge"

if (-not (Test-Path -LiteralPath $source)) {
    throw "Hook source not found at $source"
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".git"))) {
    throw "$repoRoot is not a git repository"
}

Copy-Item -LiteralPath $source -Destination $destination -Force

Write-Host "Installed post-merge hook:"
Write-Host "  $destination"
Write-Host ""
Write-Host "From now on, run:"
Write-Host "  cd $repoRoot"
Write-Host "  git pull"
Write-Host ""
Write-Host "The hook copies freejam.js into Spicetify and re-applies it automatically."
Write-Host "Set FREEJAM_NO_RESTART=1 before pulling to avoid restarting Spotify."
