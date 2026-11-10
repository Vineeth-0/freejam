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

function Copy-TrackedTree {
    param([string]$Prefix, [string]$Destination)
    $prefixPath = $Prefix.TrimEnd('/') + '/'
    foreach ($relative in @(git -c safe.directory=* -C $repoRoot ls-files -- $Prefix)) {
        if ($relative -match '(^|/)(\.env($|\.)|.*\.(pem|key|p12|pfx)$|notifier-config\.json$)') { continue }
        $source = Join-Path $repoRoot ($relative -replace '/', '\')
        $target = Join-Path $Destination (($relative.Substring($prefixPath.Length)) -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

try {
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    # Friend bundle: extension, the full guide, optional notifier.
    $friend = Join-Path $stage "friend"
    New-Item -ItemType Directory -Force -Path (Join-Path $friend "notifier") | Out-Null
    Copy-RepoFile "freejam.js" $friend
    Copy-RepoFile "README.md" (Join-Path $friend "FreeJam-README.md")
    Copy-TrackedTree "notifier" (Join-Path $friend "notifier")
    Compress-Archive -Path (Join-Path $friend "*") -DestinationPath (Join-Path $output "FreeJam-Friend.zip") -Force

    # Main bundle: everything a host needs.
    $main = Join-Path $stage "main"
    New-Item -ItemType Directory -Force -Path (Join-Path $main "notifier") | Out-Null
    foreach ($file in @(
        "freejam.js",
        "freejam-relay.js",
        "freejam-relay.service",
        "freejam-tunnel.service"
    )) {
        Copy-RepoFile $file $main
    }
    Copy-RepoFile "README.md" (Join-Path $main "FreeJam-README.md")
    Copy-TrackedTree "notifier" (Join-Path $main "notifier")
    Compress-Archive -Path (Join-Path $main "*") -DestinationPath (Join-Path $output "FreeJam.zip") -Force

    # Full source bundle contains only tracked source files; ignored local files
    # (including env files and notifier configuration) can never enter it.
    $fullRoot = Join-Path $stage "full"
    $full = Join-Path $fullRoot "FreeJam"
    New-Item -ItemType Directory -Force -Path $full | Out-Null
    $trackedFiles = @(git -c safe.directory=* -C $repoRoot ls-files)
    if ($LASTEXITCODE -ne 0) { throw "Could not enumerate tracked source files" }
    foreach ($relative in $trackedFiles) {
        if ($relative -match '(^|/)(\.env($|\.)|.*\.(pem|key|p12|pfx)$|notifier-config\.json$)' -or $relative -match '\.(zip|log)$') { continue }
        $source = Join-Path $repoRoot ($relative -replace '/', '\')
        $destination = Join-Path $full ($relative -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
    Compress-Archive -Path (Join-Path $fullRoot "*") -DestinationPath (Join-Path $output "FreeJam2.zip") -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $output "FreeJam2.zip"))
    try {
        $secretPatterns = @(
            '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
            '\bAKIA[0-9A-Z]{16}\b',
            '\bgh[pousr]_[A-Za-z0-9_]{30,}\b',
            '\bxox[baprs]-[A-Za-z0-9-]{20,}\b',
            '\bAIza[0-9A-Za-z_-]{35}\b',
            '\bsk-[A-Za-z0-9]{32,}\b'
        )
        $unsafeEntry = $archive.Entries | Where-Object { $_.FullName -match '(^|/)(\.env($|\.)|.*\.(pem|key|p12|pfx)$|notifier-config\.json$)' } | Select-Object -First 1
        if ($unsafeEntry) { throw "Unsafe secret/config file in source archive: $($unsafeEntry.FullName)" }
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -notmatch '\.(js|json|md|ps1|yml|yaml|ini|txt|sh|service|toml|conf)$') { continue }
            $stream = $entry.Open()
            $reader = [System.IO.StreamReader]::new($stream)
            try {
                $content = $reader.ReadToEnd()
                foreach ($pattern in $secretPatterns) {
                    if ($content -match $pattern) { throw "Credential-like value in source archive: $($entry.FullName)" }
                }
            } finally {
                $reader.Dispose()
            }
        }
    } finally { $archive.Dispose() }

    # Relay-only deployment bundle.
    $relay = Join-Path $stage "relay"
    New-Item -ItemType Directory -Force -Path $relay | Out-Null
    foreach ($file in @(
        "freejam-relay.js",
        "package.json",
        "Dockerfile",
        "freejam-relay.service",
        "freejam-tunnel.service"
    )) {
        Copy-RepoFile $file $relay
    }
    Copy-RepoFile "README.md" (Join-Path $relay "FreeJam-README.md")
    Compress-Archive -Path (Join-Path $relay "*") -DestinationPath (Join-Path $output "FreeJam-relay-deploy.zip") -Force

    # Notifier-only bundle.
    $notifier = Join-Path $stage "notifier"
    New-Item -ItemType Directory -Force -Path (Join-Path $notifier "notifier") | Out-Null
    Copy-RepoFile "README.md" (Join-Path $notifier "FreeJam-README.md")
    Copy-TrackedTree "notifier" (Join-Path $notifier "notifier")
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
