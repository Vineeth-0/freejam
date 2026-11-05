[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "freejam.js"
if (-not (Test-Path -LiteralPath $source)) {
    throw "freejam.js not found at $source"
}

$extensionsDir = Join-Path $env:APPDATA "spicetify\Extensions"
$target = Join-Path $extensionsDir "freejam.js"

$spicetify = Join-Path $env:LOCALAPPDATA "spicetify\spicetify.exe"
if (-not (Test-Path -LiteralPath $spicetify)) {
    $cmd = Get-Command spicetify -ErrorAction SilentlyContinue
    if ($cmd) { $spicetify = $cmd.Source }
}
if (-not (Test-Path -LiteralPath $spicetify)) {
    throw "spicetify CLI not found. Install Spicetify or add it to PATH."
}

$restartNote = if ($NoRestart) { " -n" } else { "" }

if ($DryRun) {
    Write-Host "FreeJam dry run:"
    Write-Host "  copy: $source"
    Write-Host "    to: $target"
    Write-Host "  ensure config extensions includes freejam.js"
    Write-Host "  run:  $spicetify apply$restartNote"
    return
}

Write-Host "FreeJam: copying extension to Spicetify..."
New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force

# `spicetify config extensions <name>` appends to the list, so only call it
# when freejam.js is not already present.
$configPath = Join-Path $env:APPDATA "spicetify\config-xpui.ini"
$hasExtension = $false
if (Test-Path -LiteralPath $configPath) {
    $line = Get-Content -LiteralPath $configPath |
        Where-Object { $_ -match '^\s*extensions\s*=' } |
        Select-Object -First 1
    if ($line) {
        $value = ($line -split '=', 2)[1]
        $names = $value -split '\|' | ForEach-Object { $_.Trim() }
        $hasExtension = $names -contains 'freejam.js'
    }
}
if (-not $hasExtension) {
    Write-Host "FreeJam: enabling extension in Spicetify config..."
    & $spicetify config extensions freejam.js | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "spicetify config failed with exit code $LASTEXITCODE"
    }
}

Write-Host "FreeJam: applying Spicetify (Spotify will restart)..."
$applyArgs = @("apply")
if ($NoRestart) { $applyArgs += "-n" }
& $spicetify @applyArgs
if ($LASTEXITCODE -ne 0) {
    throw "spicetify apply failed with exit code $LASTEXITCODE"
}

Write-Host "FreeJam: extension updated."
