param(
  [string]$Root = "",
  [string]$SourceRoot = "",
  [string]$OldPid = "",
  [string]$OldBootIdentity = "",
  [string]$OldProcessCreatedAt = "",
  [ValidateSet("preserve", "managed")]
  [string]$RelativePathPolicy = "preserve",
  [string]$Database = "",
  [string]$Storage = "",
  [string]$Temp = "",
  [string]$ServicePort = "",
  [string]$ReleaseVersion = "",
  [switch]$AcceptPathChange,
  [switch]$DryRun,
  [Alias("h")]
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))

if ($Help -or $args -contains "--help" -or $args -contains "-h") {
  @"
FileStation manual bootstrap

Prepare the old process identity before stopping it:
  scripts/bootstrap-update.ps1 -Root C:\FileStation -SourceRoot C:\old \
    -OldPid 1234 -OldBootIdentity <boot-id> `
    -OldProcessCreatedAt <process-creation-id> `
    -RelativePathPolicy preserve

The trusted helper performs only safety probes; it never stops or signals the
old process. Nginx files and services are never modified or reloaded.

Restore:
  Stop the managed process, inspect <Root>\backups\<id>\MANIFEST.json, restore
  legacy-source plus env\legacy.env to a separate exact path, then start the old
  command from the original legacy root. Never run old and new versions against
  the same database/storage.
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
if (-not $SourceRoot) { $SourceRoot = (Get-Location).Path }
$cli = Join-Path $repositoryRoot "apps/updater/dist/cli.js"
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "Updater CLI is not built. Run: npm run build --workspace=@filestation/updater"
}

$cliArguments = @(
  $cli,
  "bootstrap",
  "--root", $Root,
  "--source-root", $SourceRoot,
  "--old-pid", $OldPid,
  "--old-boot-identity", $OldBootIdentity,
  "--old-process-created-at", $OldProcessCreatedAt,
  "--relative-path-policy", $RelativePathPolicy
)
if ($Database) { $cliArguments += @("--database", $Database) }
if ($Storage) { $cliArguments += @("--storage", $Storage) }
if ($Temp) { $cliArguments += @("--temp", $Temp) }
if ($ServicePort) { $cliArguments += @("--service-port", $ServicePort) }
if ($ReleaseVersion) { $cliArguments += @("--release-version", $ReleaseVersion) }
if ($AcceptPathChange) { $cliArguments += "--accept-path-change" }
if ($DryRun) { $cliArguments += "--dry-run" }

$node = Resolve-FileStationNode
& $node @cliArguments
exit $LASTEXITCODE
