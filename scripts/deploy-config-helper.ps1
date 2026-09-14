[CmdletBinding()]
param(
    [string]$KeyPath = $env:FINANCE_VPS_SSH_KEY,
    [string]$HostName = $env:FINANCE_VPS_HOST,
    [string]$RemoteProject = '/opt/accountant/receipt-collector'
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($KeyPath) -or [string]::IsNullOrWhiteSpace($HostName)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stage = "/tmp/config-helper-$stamp"
$backup = "$RemoteProject/.deploy-backups/config-helper-$stamp"
$target = "root@$HostName"
function Run([string]$file, [string[]]$arguments) { & $file @arguments; if ($LASTEXITCODE -ne 0) { throw "native command failed: $file" } }
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw 'SSH key was not found' }
try {
  Run 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,"mkdir -p '$stage' && chmod 700 '$stage'")
  Run 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $root 'scripts\receipt-config-update.js'),"$target`:$stage/receipt-config-update.js")
  Run 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $root 'src\fns-user-onboarding.js'),"$target`:$stage/fns-user-onboarding.js")
  Run 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,(Join-Path $root 'scripts\fns-user-runtime.sh'),"$target`:$stage/fns-user-runtime.sh")
  $remote = @'
set -eu
mkdir -p '__BACKUP__'
cp -p '__PROJECT__/src/fns-user-onboarding.js' '__BACKUP__/fns-user-onboarding.js'
cp -p /usr/local/sbin/fns-user-runtime '__BACKUP__/fns-user-runtime' 2>/dev/null || true
cp -p /usr/local/sbin/receipt-config-update '__BACKUP__/receipt-config-update' 2>/dev/null || true
cp -p /usr/local/libexec/receipt-config-update.js '__BACKUP__/receipt-config-update.js' 2>/dev/null || true
cp -p /etc/sudoers.d/receiptcollector-config-update '__BACKUP__/receiptcollector-config-update' 2>/dev/null || true
rollback_needed=1
rollback() {
  [ "$rollback_needed" -eq 1 ] || exit 0
  cp -p '__BACKUP__/fns-user-onboarding.js' '__PROJECT__/src/fns-user-onboarding.js'
  [ -f '__BACKUP__/fns-user-runtime' ] && cp -p '__BACKUP__/fns-user-runtime' /usr/local/sbin/fns-user-runtime || true
  [ -f '__BACKUP__/receipt-config-update' ] && cp -p '__BACKUP__/receipt-config-update' /usr/local/sbin/receipt-config-update || true
  [ -f '__BACKUP__/receipt-config-update.js' ] && cp -p '__BACKUP__/receipt-config-update.js' /usr/local/libexec/receipt-config-update.js || true
  [ -f '__BACKUP__/receiptcollector-config-update' ] && cp -p '__BACKUP__/receiptcollector-config-update' /etc/sudoers.d/receiptcollector-config-update || true
}
trap rollback EXIT
install -o root -g root -m 0755 '__STAGE__/receipt-config-update.js' /usr/local/libexec/receipt-config-update.js
printf '%s\n' '#!/bin/sh' 'exec /usr/bin/node /usr/local/libexec/receipt-config-update.js' > /usr/local/sbin/receipt-config-update
chown root:root /usr/local/sbin/receipt-config-update /usr/local/libexec/receipt-config-update.js
chmod 0755 /usr/local/sbin/receipt-config-update /usr/local/libexec/receipt-config-update.js
install -o root -g root -m 0755 '__STAGE__/fns-user-runtime.sh' /usr/local/sbin/fns-user-runtime
printf '%s\n' 'receiptcollector ALL=(root) NOPASSWD: /usr/local/sbin/receipt-config-update' > /etc/sudoers.d/receiptcollector-config-update
chmod 0440 /etc/sudoers.d/receiptcollector-config-update
visudo -cf /etc/sudoers.d/receiptcollector-config-update
install -o receiptcollector -g receiptcollector -m 0644 '__STAGE__/fns-user-onboarding.js' '__PROJECT__/src/fns-user-onboarding.js'
/usr/bin/node --check '__PROJECT__/src/fns-user-onboarding.js'
rm -rf '__STAGE__'
rollback_needed=0
trap - EXIT
echo CONFIG_HELPER_DEPLOYMENT_SUCCESS=1
echo BACKUP='__BACKUP__'
'@
  $remote = $remote.Replace('__PROJECT__', $RemoteProject).Replace('__STAGE__', $stage).Replace('__BACKUP__', $backup)
  Run 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$target,$remote)
} finally { }
