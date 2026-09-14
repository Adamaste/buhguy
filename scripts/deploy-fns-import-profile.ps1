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
$localStage = Join-Path $projectRoot ".codex-import-profile-$timestamp"
$remoteStage = "/tmp/fns-import-profile-$timestamp"
$backup = "$RemoteProject/.deploy-backups/import-profile-$timestamp"
$targetFiles = [ordered]@{
    'src/cli.js' = "$RemoteProject/src/cli.js"
    'src/onboarding-browser.js' = "$RemoteProject/src/onboarding-browser.js"
    'scripts/fns-user-runtime.sh' = '/usr/local/sbin/fns-user-runtime'
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $out = Join-Path $localStage ([guid]::NewGuid().ToString() + '.out')
    $err = Join-Path $localStage ([guid]::NewGuid().ToString() + '.err')
    try {
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $projectRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue)
            Stderr = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue)
        }
    } finally {
        Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH key was not found: $KeyPath" }
New-Item -ItemType Directory -Path $localStage -Force | Out-Null

try {
    $hashes = [ordered]@{}
    foreach ($relative in $targetFiles.Keys) {
        $local = Join-Path $projectRoot ($relative -replace '/', '\')
        if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { throw "Missing candidate: $relative" }
        $hashes[$relative] = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    $remoteScript = @'
#!/bin/sh
set -eu
project='__PROJECT__'
stage='__STAGE__'
backup='__BACKUP__'
installed=0
rollback() {
  [ "$installed" -eq 1 ] || exit 0
  for rel in src/cli.js src/onboarding-browser.js; do
    if [ -f "$backup/$rel" ]; then
      cp -p "$backup/$rel" "$project/.import-profile-rollback.$$"
      mv -f "$project/.import-profile-rollback.$$" "$project/$rel"
    else
      rm -f "$project/$rel"
    fi
  done
  if [ -f "$backup/fns-user-runtime" ]; then
    cp -p "$backup/fns-user-runtime" /usr/local/sbin/.fns-user-runtime.rollback.$$
    mv -f /usr/local/sbin/.fns-user-runtime.rollback.$$ /usr/local/sbin/fns-user-runtime
  else
    rm -f /usr/local/sbin/fns-user-runtime
  fi
}
trap rollback EXIT
mkdir -p "$backup" "$project/.import-profile-stage/$(dirname src/cli.js)" "$project/.import-profile-stage/$(dirname src/onboarding-browser.js)"
for rel in src/cli.js src/onboarding-browser.js; do
  mkdir -p "$backup/$(dirname "$rel")"
  cp -p "$project/$rel" "$backup/$rel"
done
cp -p /usr/local/sbin/fns-user-runtime "$backup/fns-user-runtime"
mkdir -p "$project/.import-profile-stage/src"
cp "$stage/src/cli.js" "$project/.import-profile-stage/src/cli.js"
cp "$stage/src/onboarding-browser.js" "$project/.import-profile-stage/src/onboarding-browser.js"
cp "$stage/fns-user-runtime" /usr/local/sbin/.fns-user-runtime.stage.$$
chown --reference="$project/src/cli.js" "$project/.import-profile-stage/src/cli.js"
chmod --reference="$project/src/cli.js" "$project/.import-profile-stage/src/cli.js"
chown --reference="$project/src/onboarding-browser.js" "$project/.import-profile-stage/src/onboarding-browser.js"
chmod --reference="$project/src/onboarding-browser.js" "$project/.import-profile-stage/src/onboarding-browser.js"
chown --reference=/usr/local/sbin/fns-user-runtime /usr/local/sbin/.fns-user-runtime.stage.$$
chmod --reference=/usr/local/sbin/fns-user-runtime /usr/local/sbin/.fns-user-runtime.stage.$$
mv -f "$project/.import-profile-stage/src/cli.js" "$project/src/cli.js"
mv -f "$project/.import-profile-stage/src/onboarding-browser.js" "$project/src/onboarding-browser.js"
mv -f /usr/local/sbin/.fns-user-runtime.stage.$$ /usr/local/sbin/fns-user-runtime
installed=1
/usr/bin/node --check "$project/src/cli.js"
/usr/bin/node --check "$project/src/onboarding-browser.js"
sh -n /usr/local/sbin/fns-user-runtime
grep -q 'add|import-profile|status|retry|disable|enable' /usr/local/sbin/fns-user-runtime
sha256sum "$project/src/cli.js" "$project/src/onboarding-browser.js" /usr/local/sbin/fns-user-runtime
rm -rf "$project/.import-profile-stage" "$stage"
installed=0
trap - EXIT
echo DEPLOYMENT_SUCCESS=1
echo BACKUP="$backup"
'@
    $remoteScript = $remoteScript.Replace('__PROJECT__', $RemoteProject).Replace('__STAGE__', $remoteStage).Replace('__BACKUP__', $backup)
    Set-Content -LiteralPath (Join-Path $localStage 'deploy.sh') -Value $remoteScript -Encoding ASCII -NoNewline

    $sshTarget = "root@$HostName"
    $prep = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$sshTarget,"mkdir -p '$remoteStage/src' && chmod 700 '$remoteStage'")
    if ($prep.ExitCode -ne 0) { throw "Remote staging failed: $($prep.Stderr.Trim())" }
    foreach ($relative in $targetFiles.Keys) {
        $local = Join-Path $projectRoot ($relative -replace '/', '\')
        $remoteName = if ($relative -eq 'scripts/fns-user-runtime.sh') { 'fns-user-runtime' } else { $relative }
        $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$local,"$sshTarget`:$remoteStage/$remoteName")
        if ($copy.ExitCode -ne 0) { throw "Upload failed: $relative" }
    }
    $copyScript = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $localStage 'deploy.sh'),"$sshTarget`:$remoteStage/deploy.sh")
    if ($copyScript.ExitCode -ne 0) { throw 'Deployment script upload failed' }
    $run = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$sshTarget,"chmod 700 '$remoteStage/deploy.sh' && '$remoteStage/deploy.sh'")
    if ($run.Stdout) { $run.Stdout | Write-Output }
    if ($run.ExitCode -ne 0) { throw "Deployment failed: $($run.Stderr.Trim())" }
} finally {
    Remove-Item -LiteralPath $localStage -Recurse -Force -ErrorAction SilentlyContinue
}
