[CmdletBinding()]
param(
    [string]$KeyPath = $env:FINANCE_VPS_SSH_KEY,
    [string]$HostName = $env:FINANCE_VPS_HOST,
    [string]$RemoteProject = '/opt/accountant/receipt-collector'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($KeyPath) -or [string]::IsNullOrWhiteSpace($HostName)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$localStage = Join-Path $projectRoot ".codex-cli-progress-$timestamp"
$remoteStage = "/tmp/cli-progress-$timestamp"
$backup = "$RemoteProject/.deploy-backups/cli-progress-$timestamp"
$localFile = Join-Path $projectRoot 'src\cli.js'

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $out = Join-Path $localStage ([guid]::NewGuid().ToString() + '.out')
    $err = Join-Path $localStage ([guid]::NewGuid().ToString() + '.err')
    try {
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $projectRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue); Stderr = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
    } finally { Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH key was not found: $KeyPath" }
if (-not (Test-Path -LiteralPath $localFile -PathType Leaf)) { throw 'Candidate cli.js is missing' }
New-Item -ItemType Directory -Path $localStage -Force | Out-Null
try {
    $script = @'
#!/bin/sh
set -eu
project='__PROJECT__'
stage='__STAGE__'
backup='__BACKUP__'
target="$project/src/cli.js"
rollback_needed=0
rollback() {
  [ "$rollback_needed" -eq 1 ] || exit 0
  cp -p "$backup/cli.js" "$project/.cli.rollback.$$"
  mv -f "$project/.cli.rollback.$$" "$target"
}
trap rollback EXIT
mkdir -p "$backup" "$project/.cli-progress-stage"
cp -p "$target" "$backup/cli.js"
cp "$stage/cli.js" "$project/.cli-progress-stage/cli.js"
chown --reference="$target" "$project/.cli-progress-stage/cli.js"
chmod --reference="$target" "$project/.cli-progress-stage/cli.js"
mv -f "$project/.cli-progress-stage/cli.js" "$target"
rollback_needed=1
/usr/bin/node --check "$target"
rm -rf "$project/.cli-progress-stage" "$stage"
rollback_needed=0
trap - EXIT
sha256sum "$target"
echo DEPLOYMENT_SUCCESS=1
echo BACKUP="$backup"
'@
    $script = $script.Replace('__PROJECT__', $RemoteProject).Replace('__STAGE__', $remoteStage).Replace('__BACKUP__', $backup)
    Set-Content -LiteralPath (Join-Path $localStage 'deploy.sh') -Value $script -Encoding ASCII -NoNewline
    $target = "root@$HostName"
    $prep = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,"mkdir -p '$remoteStage' && chmod 700 '$remoteStage'")
    if ($prep.ExitCode -ne 0) { throw "Remote staging failed: $($prep.Stderr.Trim())" }
    $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$localFile,"$target`:$remoteStage/cli.js")
    if ($copy.ExitCode -ne 0) { throw 'Candidate upload failed' }
    $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $localStage 'deploy.sh'),"$target`:$remoteStage/deploy.sh")
    if ($copy.ExitCode -ne 0) { throw 'Deployment script upload failed' }
    $run = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,"chmod 700 '$remoteStage/deploy.sh' && '$remoteStage/deploy.sh'")
    if ($run.Stdout) { $run.Stdout | Write-Output }
    if ($run.ExitCode -ne 0) { throw "Deployment failed: $($run.Stderr.Trim())" }
} finally { Remove-Item -LiteralPath $localStage -Recurse -Force -ErrorAction SilentlyContinue }
