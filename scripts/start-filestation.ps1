param(
  [string]$Root = "",
  [switch]$DryRun,
  [switch]$ByNginx,
  [Alias("h")]
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))

if ($Help -or $args -contains "--help" -or $args -contains "-h") {
  @"
FileStation managed launcher

  scripts/start-filestation.ps1 -Root C:\FileStation
  scripts/start-filestation.ps1 -Root C:\FileStation -DryRun
  scripts/start-filestation.ps1 -Root C:\FileStation -ByNginx

The root .env is loaded first; variables already present in the calling process
win. The launcher validates cwd, current release, metadata and canonical paths
before the server module can create directories or open the database.
"@
  exit 0
}

function Resolve-FileStationNode {
  if ($env:FILESTATION_NODE) {
    $candidate = $env:FILESTATION_NODE
  } else {
    $command = Get-Command node -ErrorAction Stop
    $candidate = $command.Source
  }
  $nodeVersion = (& $candidate -p "process.versions.node").Trim()
  $parts = $nodeVersion.Split(".") | ForEach-Object { [int]$_ }
  $supported = $parts[0] -gt 20 -or (
    $parts[0] -eq 20 -and (
      $parts[1] -gt 17 -or ($parts[1] -eq 17 -and $parts[2] -ge 0)
    )
  )
  if (-not $supported) {
    throw "FileStation requires Node.js 20.17.0 or newer."
  }
  return $candidate
}

if (-not $Root) { $Root = $repositoryRoot }
$cli = Join-Path $repositoryRoot "apps/updater/dist/cli.js"
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "Updater CLI is not built. Run: npm run build --workspace=@filestation/updater"
}
if ($ByNginx) {
  $env:FILESTATION_SERVE_STATIC = "false"
  $env:FILESTATION_HOST = "127.0.0.1"
}

$cliArguments = @($cli, "launch", "--root", $Root)
if ($DryRun) { $cliArguments += "--dry-run" }
$node = Resolve-FileStationNode
& $node @cliArguments
exit $LASTEXITCODE
