[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Code,

    [string]$ConfigPath = (Join-Path $env:APPDATA "FreeJam\notifier.json"),

    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "freejam-notifier.js"
if (-not (Test-Path -LiteralPath $source)) {
    throw "freejam-notifier.js was not found next to this installer."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js 18 or newer is required. Install it from https://nodejs.org/ and run this installer again."
}

if (-not $Code) {
    $Code = Read-Host "Paste the FJN1 notifier setup code"
}
$Code = $Code.Trim()
if (-not $Code.StartsWith("FJN1.")) {
    throw "That does not look like a FreeJam notifier setup code (it should start with FJN1.)."
}

$installDir = Join-Path $env:APPDATA "FreeJam\notifier"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$target = Join-Path $installDir "freejam-notifier.js"
Copy-Item -LiteralPath $source -Destination $target -Force

$uninstaller = Join-Path $PSScriptRoot "uninstall-notifier.ps1"
if (Test-Path -LiteralPath $uninstaller) {
    Copy-Item -LiteralPath $uninstaller -Destination (Join-Path $installDir "uninstall-notifier.ps1") -Force
}

Write-Host "FreeJam: saving notifier setup..."
& $node.Source $target --install $Code --config $ConfigPath
if ($LASTEXITCODE -ne 0) {
    throw "The notifier could not save the setup code."
}

# Run Node through wscript so there is no console window at login.
$vbsPath = Join-Path $installDir "freejam-notifier.vbs"
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Run """$($node.Source)"" ""$target"" --config ""$ConfigPath""", 0, False
"@
Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding ASCII

$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "FreeJam Notifier.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shortcut.Arguments = "`"$vbsPath`""
$shortcut.WorkingDirectory = $installDir
$shortcut.WindowStyle = 7
$shortcut.Description = "FreeJam background jam alerts"
$shortcut.Save()

# Restart any old copy so the new config takes effect immediately.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($target)
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

if (-not $NoStart) {
    Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") `
        -ArgumentList "`"$vbsPath`"" `
        -WindowStyle Hidden
}

Write-Host ""
Write-Host "FreeJam background notifier installed."
if ($NoStart) {
    Write-Host "It will start automatically at login."
    Write-Host "Start it now: wscript.exe `"$vbsPath`""
} else {
    Write-Host "It starts automatically at login and is running now."
}
Write-Host "Config: $ConfigPath"
Write-Host "Test it: node `"$target`" --test --config `"$ConfigPath`""
Write-Host "Uninstall: powershell -ExecutionPolicy RemoteSigned -File `"$installDir\uninstall-notifier.ps1`""
