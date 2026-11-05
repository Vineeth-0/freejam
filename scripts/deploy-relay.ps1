[CmdletBinding()]
param(
    [string]$PiHost = $env:FREEJAM_PI_HOST,
    [string]$PiUser = $env:FREEJAM_PI_USER,
    [string]$RemoteDir = $env:FREEJAM_PI_DIR,
    [string]$Service = $env:FREEJAM_PI_SERVICE,
    [switch]$DryRun
)

# Deploy freejam-relay.js to the Raspberry Pi (or any SSH host) and restart
# the systemd service.
#
# Configure once with environment variables, or pass parameters:
#   FREEJAM_PI_HOST      hostname or IP, e.g. 192.168.x.x
#   FREEJAM_PI_USER      SSH user, default freejam
#   FREEJAM_PI_DIR       remote directory, default ~/freejam
#   FREEJAM_PI_SERVICE   systemd unit, default freejam-relay
#
# Example:
#   .\scripts\deploy-relay.ps1 -PiHost 192.168.x.x
#
# If the Pi is offline this script prints a warning and exits 0, so a git pull
# is never blocked by a sleeping Pi.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "freejam-relay.js"
if (-not (Test-Path -LiteralPath $source)) {
    throw "freejam-relay.js not found at $source"
}

if (-not $PiHost) {
    Write-Warning "FREEJAM_PI_HOST / -PiHost is not set; skipping relay deployment."
    return
}
if (-not $PiUser) { $PiUser = "freejam" }
if (-not $RemoteDir) { $RemoteDir = "~/freejam" }
if (-not $Service) { $Service = "freejam-relay" }

$ssh = Get-Command ssh -ErrorAction SilentlyContinue
$scp = Get-Command scp -ErrorAction SilentlyContinue
if (-not $ssh -or -not $scp) {
    Write-Warning "OpenSSH client (ssh/scp) not found; skipping relay deployment."
    return
}

$remote = "$PiUser@$PiHost"
$target = "$remote`:$RemoteDir/freejam-relay.js"

if ($DryRun) {
    Write-Host "FreeJam relay dry run:"
    Write-Host "  scp $source $target"
    Write-Host "  ssh $remote `"sudo systemctl restart $Service`""
    return
}

Write-Host "FreeJam: copying relay to $remote..."
& $scp.Source -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new `
    $source $target
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not copy the relay to $remote. Is the Pi online and reachable over SSH?"
    return
}

Write-Host "FreeJam: restarting $Service..."
& $ssh.Source -o BatchMode=yes -o ConnectTimeout=8 $remote "sudo systemctl restart $Service"
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Copied the relay, but could not restart $Service. Run: ssh $remote `"sudo systemctl restart $Service`""
    return
}

Write-Host "FreeJam: relay deployed and restarted."
