<#
.SYNOPSIS
  Start Docker Desktop (working around its stale-socket startup crash), then the local UCG Postgres.

.DESCRIPTION
  On this Windows machine Docker Desktop leaves AF_UNIX socket files behind on EVERY shutdown,
  graceful or not. On the next start its backend tries to rename them to *.stale, which fails
  ("rename ...sock: The file cannot be accessed by the system") and Docker shows
  "An unexpected error occurred". Deleting the socket files does not work; renaming their parent
  directories aside does, and Docker recreates them. Both directories must be cleared together —
  clearing only one just moves the crash to the other.

  Usage (PowerShell, from the project root):
    .\local\start-docker.ps1            # Docker + local Postgres
    .\local\start-docker.ps1 -SkipDb    # Docker only

  The *.stale-<timestamp> directories it leaves in %LOCALAPPDATA% hold only 0-byte socket files.
#>
param([switch]$SkipDb)

$docker   = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$desktop  = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$log      = Join-Path $env:LOCALAPPDATA "Docker\log\host\com.docker.backend.exe.log"
$compose  = Join-Path $PSScriptRoot "docker-compose.yml"
$socketDirs = @(
  (Join-Path $env:LOCALAPPDATA "Docker\run"),
  (Join-Path $env:LOCALAPPDATA "docker-secrets-engine")
)

function Test-DockerReady {
  $job = Start-Job -ArgumentList $docker { param($d) & $d info --format '{{.ServerVersion}}' 2>&1 | Out-String }
  $v = if (Wait-Job $job -Timeout 10) { Receive-Job $job } else { Stop-Job $job; '' }
  Remove-Job $job -Force
  return ($v -match '^\s*\d')
}

function Get-DockerProcesses {
  Get-Process | Where-Object { $_.Name -match '^(Docker Desktop|com\.docker\.)' }
}

# ── 1. Already running? ───────────────────────────────────────────────
if (Test-DockerReady) {
  Write-Host "Docker is already running."
} else {
  # ── 2. Make sure no half-dead Docker processes hold the socket dirs ──
  if (Get-DockerProcesses) {
    Write-Host "Docker processes present but daemon not ready - stopping them..."
    & $docker desktop stop 2>&1 | Out-Null
    for ($i = 0; $i -lt 15 -and (Get-DockerProcesses); $i++) { Start-Sleep -Seconds 2 }
    if (Get-DockerProcesses) {
      Write-Host "Graceful stop timed out - terminating Docker processes."
      Get-DockerProcesses | Stop-Process -Force
      Start-Sleep -Seconds 3
    }
  }

  # ── 3. Refuse to guess if sockets show up somewhere unexpected ───────
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Docker"),
    (Join-Path $env:APPDATA "Docker"),
    (Join-Path $env:USERPROFILE ".docker")
  )
  Get-ChildItem $env:LOCALAPPDATA -Directory -Force -Filter "docker*" |
    Where-Object { $_.Name -notmatch '\.stale' } | ForEach-Object { $roots += $_.FullName }
  $unexpected = foreach ($r in ($roots | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $r) {
      Get-ChildItem -LiteralPath $r -Force -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -match 'ReparsePoint' -and $_.FullName -notmatch '\.stale' -and $socketDirs -notcontains $_.DirectoryName }
    }
  }
  if ($unexpected) {
    Write-Host "ABORT: socket files found outside the known directories - not moving anything:"
    $unexpected | ForEach-Object { Write-Host "  $($_.FullName)" }
    exit 1
  }

  # ── 4. Move both socket directories aside together ──────────────────
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  foreach ($d in $socketDirs) {
    if (Test-Path -LiteralPath $d) {
      $newName = (Split-Path $d -Leaf) + ".stale-$stamp"
      Rename-Item -LiteralPath $d -NewName $newName -ErrorAction Stop
      Write-Host "Moved aside: $d -> $newName"
    }
  }

  # ── 5. Start Docker and wait for the daemon (or detect a crash) ─────
  $since = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss")
  Write-Host "Starting Docker Desktop..."
  Start-Process $desktop
  $ready = $false
  for ($i = 1; $i -le 50; $i++) {
    Start-Sleep -Seconds 6
    if (Test-DockerReady) { $ready = $true; Write-Host "Docker ready after ~$($i*6)s."; break }
    $crash = Select-String -Path $log -Pattern 'backend crashed' -ErrorAction SilentlyContinue |
      Where-Object { $_.Line.Length -gt 20 -and $_.Line.Substring(1,19) -ge $since } | Select-Object -Last 1
    if ($crash) { Write-Host "Docker crashed during startup:`n  $($crash.Line)"; exit 2 }
  }
  if (-not $ready) { Write-Host "Docker did not become ready within ~5 minutes."; exit 3 }
}

# ── 6. Local Postgres ──────────────────────────────────────────────────
if ($SkipDb) { exit 0 }
Write-Host "Starting local Postgres (ucg-postgres)..."
& $docker compose -f $compose up -d 2>&1 | Select-Object -Last 2 | ForEach-Object { "  $_" }
for ($i = 1; $i -le 24; $i++) {
  $st = (& $docker inspect -f '{{.State.Health.Status}}' ucg-postgres 2>&1 | Out-String).Trim()
  if ($st -eq 'healthy') { Write-Host "ucg-postgres is healthy on localhost:5433."; exit 0 }
  Start-Sleep -Seconds 5
}
Write-Host "ucg-postgres did not become healthy (last status: $st)."
exit 4
