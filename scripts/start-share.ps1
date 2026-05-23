param(
  [int]$Port = 3343
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Test-PortListening {
  param([int]$LocalPort)
  return [bool](Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
}

function Get-NgrokPath {
  $command = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $wingetPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"
  if (Test-Path $wingetPath) {
    return $wingetPath
  }

  throw "ngrok was not found. Install it, add it to PATH, and configure your authtoken."
}

if (-not (Test-PortListening -LocalPort $Port)) {
  Start-Process -FilePath "node" -ArgumentList "server/index.js" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

if (-not (Test-PortListening -LocalPort 4040)) {
  $ngrok = Get-NgrokPath
  Start-Process -FilePath $ngrok -ArgumentList "http", "$Port" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}

$deadline = (Get-Date).AddSeconds(20)
$publicUrl = $null

while ((Get-Date) -lt $deadline -and -not $publicUrl) {
  Start-Sleep -Milliseconds 500

  try {
    $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels"
    $publicUrl = $tunnels.tunnels |
      Where-Object { $_.proto -eq "https" } |
      Select-Object -First 1 -ExpandProperty public_url
  } catch {
    $publicUrl = $null
  }
}

if (-not $publicUrl) {
  throw "ngrok started, but no public tunnel URL was available from http://127.0.0.1:4040."
}

Write-Host ""
Write-Host "Watch Party is running locally:"
Write-Host "  http://localhost:$Port"
Write-Host ""
Write-Host "Share this URL:"
Write-Host "  $publicUrl"
Write-Host ""
