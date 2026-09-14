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
$localStage = Join-Path $projectRoot ".codex-coverage-scope-$timestamp"
$remoteStage = "/tmp/coverage-scope-$timestamp"
$backup = "$RemoteProject/.deploy-backups/coverage-scope-$timestamp"
$files = @('src\cli.js', 'src\accounting-coverage.js', 'src\fns-user-onboarding.js')

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $out = Join-Path $localStage ([guid]::NewGuid().ToString() + '.out')
    $err = Join-Path $localStage ([guid]::NewGuid().ToString() + '.err')
    try {
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $projectRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue); Stderr = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
    } finally { Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH key was not found: $KeyPath" }
foreach ($relative in $files) { if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relative) -PathType Leaf)) { throw "Candidate file is missing: $relative" } }
New-Item -ItemType Directory -Path $localStage -Force | Out-Null
try {
    $script = @'
#!/bin/sh
set -eu
project='__PROJECT__'
stage='__STAGE__'
backup='__BACKUP__'
rollback_needed=0
rollback() {
  [ "$rollback_needed" -eq 1 ] || exit 0
  for name in cli.js accounting-coverage.js fns-user-onboarding.js; do
    cp -p "$backup/$name" "$project/.$name.rollback.$$"
    mv -f "$project/.$name.rollback.$$" "$project/src/$name"
  done
}
trap rollback EXIT
mkdir -p "$backup" "$project/.coverage-scope-stage"
for name in cli.js accounting-coverage.js fns-user-onboarding.js; do
  cp -p "$project/src/$name" "$backup/$name"
  cp "$stage/$name" "$project/.coverage-scope-stage/$name"
  chown --reference="$project/src/$name" "$project/.coverage-scope-stage/$name"
  chmod --reference="$project/src/$name" "$project/.coverage-scope-stage/$name"
done
mv -f "$project/.coverage-scope-stage/cli.js" "$project/src/cli.js"
mv -f "$project/.coverage-scope-stage/accounting-coverage.js" "$project/src/accounting-coverage.js"
mv -f "$project/.coverage-scope-stage/fns-user-onboarding.js" "$project/src/fns-user-onboarding.js"
rollback_needed=1
/usr/bin/node --check "$project/src/cli.js"
/usr/bin/node --check "$project/src/accounting-coverage.js"
/usr/bin/node --check "$project/src/fns-user-onboarding.js"
rm -rf "$project/.coverage-scope-stage" "$stage"
rollback_needed=0
trap - EXIT
sha256sum "$project/src/cli.js" "$project/src/accounting-coverage.js"
echo DEPLOYMENT_SUCCESS=1
echo BACKUP="$backup"
'@
    $script = $script.Replace('__PROJECT__', $RemoteProject).Replace('__STAGE__', $remoteStage).Replace('__BACKUP__', $backup)
    Set-Content -LiteralPath (Join-Path $localStage 'deploy.sh') -Value $script -Encoding ASCII -NoNewline
    $target = "root@$HostName"
    $prep = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,"mkdir -p '$remoteStage' && chmod 700 '$remoteStage'")
    if ($prep.ExitCode -ne 0) { throw "Remote staging failed: $($prep.Stderr.Trim())" }
    foreach ($relative in $files) {
        $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $projectRoot $relative),"$target`:$remoteStage/$(Split-Path $relative -Leaf)")
        if ($copy.ExitCode -ne 0) { throw "Candidate upload failed: $relative" }
    }
    $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $localStage 'deploy.sh'),"$target`:$remoteStage/deploy.sh")
    if ($copy.ExitCode -ne 0) { throw 'Deployment script upload failed' }
    $run = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,"chmod 700 '$remoteStage/deploy.sh' && '$remoteStage/deploy.sh'")
    if ($run.Stdout) { $run.Stdout | Write-Output }
    if ($run.ExitCode -ne 0) { throw "Deployment failed: $($run.Stderr.Trim())" }
} finally { Remove-Item -LiteralPath $localStage -Recurse -Force -ErrorAction SilentlyContinue }
