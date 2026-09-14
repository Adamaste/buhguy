[CmdletBinding()]
param([string]$SshAddress=$env:FINANCE_VPS_HOST,[string]$PermanentKey=$env:FINANCE_VPS_SSH_KEY)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($SshAddress) -or [string]::IsNullOrWhiteSpace($PermanentKey)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
function ConvertTo-ProcessArgument([string]$Value){
    if($null -eq $Value -or $Value.Length -eq 0){return '""'}
    $escaped=$Value -replace '(\\*)"','$1$1\"'
    $escaped=$escaped -replace '(\\+)$','$1$1'
    return '"'+$escaped+'"'
}
function Invoke-SshPayload([string]$FilePath,[string[]]$Arguments,[string]$Payload){
    $psi=New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName=$FilePath; $psi.UseShellExecute=$false
    $psi.RedirectStandardInput=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $psi.Arguments=(($Arguments|ForEach-Object{ConvertTo-ProcessArgument $_}) -join ' ')
    $process=New-Object System.Diagnostics.Process; $process.StartInfo=$psi
    [void]$process.Start()
    $stdoutTask=$process.StandardOutput.ReadToEndAsync(); $stderrTask=$process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($Payload); $process.StandardInput.Close(); $process.WaitForExit()
    [pscustomobject]@{ ExitCode=$process.ExitCode; Stdout=$stdoutTask.Result; Stderr=$stderrTask.Result }
}
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path;$accessDir=Join-Path $projectRoot '.codex-access';$tempKey=Join-Path $accessDir 'finance-codex-temp'
if(-not(Test-Path -LiteralPath $PermanentKey -PathType Leaf)){throw 'Permanent SSH key path does not exist'}
$remote=@'
set -eu
rm -f /etc/ssh/authorized_keys/codex-receipt /etc/sudoers.d/receipt-codex-admin /etc/ssh/sshd_config.d/receipt-codex.conf
systemctl disable --now receipt-codex-expiry.timer 2>/dev/null || true
rm -f /etc/systemd/system/receipt-codex-expiry.timer /etc/systemd/system/receipt-codex-expiry.service /usr/local/sbin/receipt-codex-admin /usr/local/sbin/receipt-codex-admin-shell
if id codex-receipt >/dev/null 2>&1; then userdel --remove codex-receipt || userdel codex-receipt; fi
systemctl daemon-reload; sshd -t; systemctl reload ssh || systemctl reload sshd
'@
$revokeResult=Invoke-SshPayload 'ssh.exe' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-i',$PermanentKey,"root@$SshAddress",'bash -s') $remote
if($revokeResult.ExitCode -ne 0){throw 'Remote revoke failed'}
if(Test-Path -LiteralPath $tempKey){
    $probe=@(& ssh.exe -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -i $tempKey "codex-receipt@$SshAddress" capabilities 2>&1)
    $probeExit=$LASTEXITCODE
    $probeText=($probe -join ' ')
    if($probeExit -eq 0){throw 'Temporary key still authenticates'}
    if($probeText -notmatch '(?i)permission denied|sign_and_send_pubkey|no supported authentication methods'){
        throw 'Temporary key revoke could not be verified'
    }
}
if(Test-Path -LiteralPath $accessDir){Remove-Item -LiteralPath $accessDir -Recurse -Force}
Write-Output 'Temporary Codex VPS access revoked.'
