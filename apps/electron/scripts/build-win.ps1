# PolyBot Windows NSIS — craft-style wrapper (no Anthropic/Bun vendor downloads).
# Usage: powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

$EnvFile = Join-Path $RootDir ".env"
if (Test-Path $EnvFile) {
    Write-Host "Loading $EnvFile (set lines as KEY=value)"
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
        $pair = $_ -split '=', 2
        if ($pair.Length -eq 2) {
            $k = $pair[0].Trim()
            $v = $pair[1].Trim().Trim('"')
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
}

Write-Host "=== PolyBot Windows (electron-builder) ===" -ForegroundColor Cyan
Set-Location $RootDir
bun install
bun run electron:build

Set-Location $ElectronDir
& bun x electron-builder --config electron-builder.yml --win @args
