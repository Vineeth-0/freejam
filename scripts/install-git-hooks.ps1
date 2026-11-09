[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$hookNames = @("post-merge", "pre-push")

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".git"))) {
    throw "$repoRoot is not a git repository"
}

foreach ($hookName in $hookNames) {
    $source = Join-Path $repoRoot "hooks\$hookName"
    $destination = Join-Path $repoRoot ".git\hooks\$hookName"
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Hook source not found at $source"
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

Write-Host "Installed post-merge and pre-push hooks."
Write-Host ""
Write-Host "From now on, run:"
Write-Host "  cd $repoRoot"
Write-Host "  git pull"
Write-Host ""
Write-Host "Both hooks copy freejam.js into Spicetify and re-apply it automatically."
Write-Host "If freejam-relay.js changed, post-merge reminds you to restart your own relay."
Write-Host "Set FREEJAM_NO_RESTART=1 before pulling or pushing to avoid restarting Spotify."
