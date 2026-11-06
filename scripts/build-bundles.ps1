[CmdletBinding()]
param(
    [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist")
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("freejam-package-" + [guid]::NewGuid().ToString("N"))
$output = [System.IO.Path]::GetFullPath($OutputDir)

function Copy-RepoFile {
    param(
        [string]$RelativePath,
        [string]$Destination
    )

    $source = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Missing file: $RelativePath"
    }
    Copy-Item -LiteralPath $source -Destination $Destination -Force
}

try {
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    # Friend bundle: extension, friend guide, optional notifier.
    $friend = Join-Path $stage "friend"
    New-Item -ItemType Directory -Force -Path (Join-Path $friend "notifier") | Out-Null
    Copy-RepoFile "freejam.js" $friend
    Copy-RepoFile "INSTALL-FRIEND.txt" $friend
    Copy-Item -Path (Join-Path $repoRoot "notifier\*") -Destination (Join-Path $friend "notifier") -Force
    Compress-Archive -Path (Join-Path $friend "*") -DestinationPath (Join-Path $output "FreeJam-Friend.zip") -Force

    # Main bundle: everything a host needs.
    $main = Join-Path $stage "main"
    New-Item -ItemType Directory -Force -Path (Join-Path $main "notifier") | Out-Null
    foreach ($file in @(
        "freejam.js",
        "freejam-relay.js",
        "INSTALL.txt",
        "INSTALL-FRIEND.txt",
        "DEPLOY.md",
        "PI-SETUP.md",
        "freejam-relay.service",
        "freejam-tunnel.service"
    )) {
        Copy-RepoFile $file $main
    }
    Copy-RepoFile "README.md" (Join-Path $main "FreeJam-README.md")
    Copy-Item -Path (Join-Path $repoRoot "notifier\*") -Destination (Join-Path $main "notifier") -Force
    Compress-Archive -Path (Join-Path $main "*") -DestinationPath (Join-Path $output "FreeJam.zip") -Force

    # Full source tree, without git metadata or previous archives.
    $fullRoot = Join-Path $stage "full"
    $full = Join-Path $fullRoot "FreeJam"
    New-Item -ItemType Directory -Force -Path $full | Out-Null
    robocopy $repoRoot $full /E /XD .git dist /XF *.zip *.log | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }
    Compress-Archive -Path (Join-Path $fullRoot "*") -DestinationPath (Join-Path $output "FreeJam2.zip") -Force

    # Relay-only deployment bundle.
    $relay = Join-Path $stage "relay"
    New-Item -ItemType Directory -Force -Path $relay | Out-Null
    foreach ($file in @(
        "freejam-relay.js",
        "package.json",
        "Dockerfile",
        "render.yaml",
        "DEPLOY.md",
        "PI-SETUP.md",
        "freejam-relay.service",
        "freejam-tunnel.service"
    )) {
        Copy-RepoFile $file $relay
    }
    Compress-Archive -Path (Join-Path $relay "*") -DestinationPath (Join-Path $output "FreeJam-relay-deploy.zip") -Force

    # Notifier-only bundle.
    $notifier = Join-Path $stage "notifier"
    New-Item -ItemType Directory -Force -Path (Join-Path $notifier "notifier") | Out-Null
    Copy-Item -Path (Join-Path $repoRoot "notifier\*") -Destination (Join-Path $notifier "notifier") -Force
    Compress-Archive -Path (Join-Path $notifier "*") -DestinationPath (Join-Path $output "FreeJam-Notifier.zip") -Force

    Get-ChildItem $output -Filter "FreeJam*.zip" |
        Select-Object Name, Length |
        Format-Table -AutoSize
}
finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
