[CmdletBinding()]
param(
    [switch]$KeepConfig
)

$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:APPDATA "FreeJam\notifier"
$target = Join-Path $installDir "freejam-notifier.js"
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "FreeJam Notifier.lnk"

if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Removed the login shortcut."
}

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($target)
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
    Write-Host "Removed $installDir"
}

if (-not $KeepConfig) {
    $configPath = Join-Path $env:APPDATA "FreeJam\notifier.json"
    if (Test-Path -LiteralPath $configPath) {
        Remove-Item -LiteralPath $configPath -Force
        Write-Host "Removed $configPath"
    }

    $dingPath = Join-Path $env:APPDATA "FreeJam\ding.wav"
    if (Test-Path -LiteralPath $dingPath) {
        Remove-Item -LiteralPath $dingPath -Force
        Write-Host "Removed $dingPath"
    }
}

$dataDir = Join-Path $env:APPDATA "FreeJam"
if ((Test-Path -LiteralPath $dataDir) -and -not (Get-ChildItem -LiteralPath $dataDir -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $dataDir -Force
    Write-Host "Removed $dataDir"
}

Write-Host "FreeJam background notifier uninstalled."
