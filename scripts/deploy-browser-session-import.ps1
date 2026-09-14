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
$localStage = Join-Path $projectRoot ".codex-browser-import-$timestamp"
$remoteStage = "/tmp/browser-session-import-$timestamp"
$backup = "$RemoteProject/.deploy-backups/browser-session-import-$timestamp"
$localFile = Join-Path $projectRoot 'src\browser-session-import.js'

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $out = Join-Path $localStage ([guid]::NewGuid().ToString() + '.out')
    $err = Join-Path $localStage ([guid]::NewGuid().ToString() + '.err')
    try {
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $projectRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue); Stderr = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
    } finally { Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH key was not found: $KeyPath" }
if (-not (Test-Path -LiteralPath $localFile -PathType Leaf)) { throw 'Candidate browser-session-import.js is missing' }
$expected = (Get-FileHash -LiteralPath $localFile -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Path $localStage -Force | Out-Null

try {
    $script = @'
#!/bin/sh
set -eu
project='__PROJECT__'
stage='__STAGE__'
backup='__BACKUP__'
target="$project/src/browser-session-import.js"
rollback_needed=0
rollback() {
  [ "$rollback_needed" -eq 1 ] || exit 0
  cp -p "$backup/browser-session-import.js" "$project/.browser-session-import.rollback.$$"
  mv -f "$project/.browser-session-import.rollback.$$" "$target"
}
trap rollback EXIT
mkdir -p "$backup" "$project/.browser-session-import-stage"
cp -p "$target" "$backup/browser-session-import.js"
cp "$stage/browser-session-import.js" "$project/.browser-session-import-stage/browser-session-import.js"
chown --reference="$target" "$project/.browser-session-import-stage/browser-session-import.js"
chmod --reference="$target" "$project/.browser-session-import-stage/browser-session-import.js"
mv -f "$project/.browser-session-import-stage/browser-session-import.js" "$target"
rollback_needed=1
/usr/bin/node --check "$target"
sha256sum "$target"
rm -rf "$project/.browser-session-import-stage" "$stage"
rollback_needed=0
trap - EXIT
echo DEPLOYMENT_SUCCESS=1
echo BACKUP="$backup"
'@
    $script = $script.Replace('__PROJECT__', $RemoteProject).Replace('__STAGE__', $remoteStage).Replace('__BACKUP__', $backup)
    Set-Content -LiteralPath (Join-Path $localStage 'deploy.sh') -Value $script -Encoding ASCII -NoNewline
    $target = "root@$HostName"
    $prep = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,"mkdir -p '$remoteStage' && chmod 700 '$remoteStage'")
    if ($prep.ExitCode -ne 0) { throw "Remote staging failed: $($prep.Stderr.Trim())" }
    $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$localFile,"$target`:$remoteStage/browser-session-import.js")
    if ($copy.ExitCode -ne 0) { throw 'Candidate upload failed' }
    $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $localStage 'deploy.sh'),"$target`:$remoteStage/deploy.sh")
    if ($copy.ExitCode -ne 0) { throw 'Deployment script upload failed' }
    $run = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,"chmod 700 '$remoteStage/deploy.sh' && '$remoteStage/deploy.sh'")
    if ($run.Stdout) { $run.Stdout | Write-Output }
    if ($run.ExitCode -ne 0) { throw "Deployment failed: $($run.Stderr.Trim())" }
} finally { Remove-Item -LiteralPath $localStage -Recurse -Force -ErrorAction SilentlyContinue }
