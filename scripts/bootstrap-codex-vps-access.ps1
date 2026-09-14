[CmdletBinding()]
param(
    [string]$SshAddress = $env:FINANCE_VPS_HOST,
    [string]$PermanentKey = $env:FINANCE_VPS_SSH_KEY,
    [ValidateRange(1,24)][int]$LifetimeHours = 6
)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
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
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$accessDir=Join-Path $projectRoot '.codex-access'; $privateKey=Join-Path $accessDir 'finance-codex-temp'; $publicKey="$privateKey.pub"
$helperPath=Join-Path $PSScriptRoot 'receipt-codex-admin.sh'; $remoteHelper="/tmp/receipt-codex-admin.$PID"
if(-not(Test-Path -LiteralPath $PermanentKey -PathType Leaf)){throw 'Permanent SSH key path does not exist'}
if(-not(Test-Path -LiteralPath $helperPath -PathType Leaf)){throw 'Server helper template is missing'}
[IO.Directory]::CreateDirectory($accessDir)|Out-Null
$privateExists=Test-Path -LiteralPath $privateKey -PathType Leaf
$publicExists=Test-Path -LiteralPath $publicKey -PathType Leaf
if($privateExists -and $publicExists){
    $existingPublic=(Get-Content -LiteralPath $publicKey -Raw).Trim()
    if($existingPublic -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+[^\r\n]+)?$'){
        Remove-Item -LiteralPath $privateKey,$publicKey -Force -ErrorAction SilentlyContinue
    }
} elseif($privateExists -or $publicExists){
    Remove-Item -LiteralPath $privateKey,$publicKey -Force -ErrorAction SilentlyContinue
}
if(-not(Test-Path -LiteralPath $privateKey -PathType Leaf)){
    $sshKeygen=(Get-Command ssh-keygen.exe -CommandType Application -ErrorAction Stop).Source
    $quotedKey='"'+$privateKey.Replace('"','\"')+'"'
    $keygenArguments='-q -t ed25519 -f {0} -N "" -C "codex-receipt-temp"' -f $quotedKey
    try{
        $keygenProcess=Start-Process -FilePath $sshKeygen -ArgumentList $keygenArguments -NoNewWindow -Wait -PassThru
        if($keygenProcess.ExitCode -ne 0){throw 'Could not create temporary ED25519 key'}
    }catch{
        Remove-Item -LiteralPath $privateKey,$publicKey -Force -ErrorAction SilentlyContinue
        throw
    }
}
if(-not(Test-Path -LiteralPath $publicKey -PathType Leaf)){throw 'Temporary public key was not created'}
$public=(((Get-Content -LiteralPath $publicKey -Raw).Trim() -split '\s+')|Select-Object -First 2)-join ' '
if($public -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+$'){throw 'Temporary public key format is invalid'}
$fingerprintOutput=& ssh-keygen.exe -lf $publicKey 2>$null
if($LASTEXITCODE -ne 0){throw 'Could not fingerprint temporary public key'}
$localFingerprint=(($fingerprintOutput -split '\s+')[1]).Trim()
if([string]::IsNullOrWhiteSpace($localFingerprint)){throw 'Temporary public key fingerprint is missing'}
$scpArguments=@('-q','-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-i',$PermanentKey,$helperPath,"root@$SshAddress`:$remoteHelper")
$scpProcess=Start-Process -FilePath 'scp.exe' -ArgumentList (($scpArguments|ForEach-Object{ConvertTo-ProcessArgument $_}) -join ' ') -NoNewWindow -Wait -PassThru
if($scpProcess.ExitCode -ne 0){throw 'Could not upload temporary helper'}
$pubB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($public))
$remote=@'
set -eu
pub=$(printf '%s' '__PUBLIC_KEY_B64__' | base64 -d)
helper='/usr/local/sbin/receipt-codex-admin'
shell='/usr/local/sbin/receipt-codex-admin-shell'
sudoers='/etc/sudoers.d/receipt-codex-admin'
match='/etc/ssh/sshd_config.d/receipt-codex.conf'
user='codex-receipt'
home='/home/codex-receipt'
install -d -m 0755 /usr/local/sbin /etc/ssh/authorized_keys
if ! id "$user" >/dev/null 2>&1; then useradd --system --home-dir "$home" --shell /usr/sbin/nologin --no-create-home "$user"; fi
group=$(id -gn "$user")
install -d -o "$user" -g "$group" -m 0700 "$home" "$home/.ssh"
install -o root -g root -m 0755 '__REMOTE_HELPER__' "$helper"; rm -f '__REMOTE_HELPER__'
cat > "$shell" <<'EOF_SHELL'
#!/bin/sh
set -eu
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  requested_command=$SSH_ORIGINAL_COMMAND
elif [ "${1:-}" = '-c' ]; then
  shift
  requested_command=$*
else
  requested_command=$*
fi
set -f
IFS=' '
set -- $requested_command
command_name=${1:-}
case "$command_name" in
  capabilities|production-identity|production-schema|production-migrations|backup-validate)
    [ "$#" -eq 1 ] || { echo CAPABILITY_DENIED >&2; exit 126; }
    exec sudo -n /usr/local/sbin/receipt-codex-admin "$@" ;;
  clone-*) exec sudo -n /usr/local/sbin/receipt-codex-admin "$@" ;;
  *) echo CAPABILITY_DENIED >&2; exit 126 ;;
esac
EOF_SHELL
chmod 0755 "$shell"; usermod --home "$home" --shell "$shell" "$user"
random_password=$(openssl rand -hex 32)
printf '%s:%s\n' "$user" "$random_password" | chpasswd
unset random_password
printf '%s %s\n' 'restrict,port-forwarding,permitopen="127.0.0.1:5432"' "$pub" > "$home/.ssh/authorized_keys"
chown "$user:$group" "$home/.ssh/authorized_keys"; chmod 0600 "$home/.ssh/authorized_keys"
rm -f "/etc/ssh/authorized_keys/$user"
printf '%s\n' "$user ALL=(root) NOPASSWD: $helper" > "$sudoers"
chown root:root "$sudoers"; chmod 0440 "$sudoers"; visudo -cf "$sudoers" >/dev/null
cat > "$match" <<EOF_MATCH
Match User $user
    AuthorizedKeysFile $home/.ssh/authorized_keys
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PubkeyAuthentication yes
    AuthenticationMethods publickey
    PermitTTY no
    X11Forwarding no
    AllowTcpForwarding local
EOF_MATCH
chown root:root "$match"; chmod 0644 "$match"
sshd -t
effective=$(sshd -T -C user="$user",host=localhost,addr=127.0.0.1)
printf '%s\n' "$effective" | grep -qx 'passwordauthentication no'
printf '%s\n' "$effective" | grep -qx 'kbdinteractiveauthentication no'
printf '%s\n' "$effective" | grep -qx 'pubkeyauthentication yes'
printf '%s\n' "$effective" | grep -qx 'authenticationmethods publickey'
server_key=$(awk '{for (i=1; i<=NF; i++) if ($i == "ssh-ed25519") {print $i" "$(i+1); exit}}' "$home/.ssh/authorized_keys")
server_fingerprint=$(printf '%s\n' "$server_key" | ssh-keygen -lf - | awk '{print $2}')
[ "$server_fingerprint" = '__EXPECTED_FINGERPRINT__' ]
cat > /etc/systemd/system/receipt-codex-expiry.service <<'EOF_SERVICE'
[Unit]
Description=Expire temporary Codex receipt access
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'rm -f /etc/ssh/authorized_keys/codex-receipt; usermod --shell /usr/sbin/nologin codex-receipt || true; systemctl reload ssh || systemctl reload sshd'
EOF_SERVICE
cat > /etc/systemd/system/receipt-codex-expiry.timer <<EOF_TIMER
[Unit]
Description=Automatic expiry for temporary Codex receipt access
[Timer]
OnActiveSec=__HOURS__h
Unit=receipt-codex-expiry.service
[Install]
WantedBy=timers.target
EOF_TIMER
systemctl daemon-reload; systemctl enable --now receipt-codex-expiry.timer
timer_state=$(systemctl is-active receipt-codex-expiry.timer)
[ "$timer_state" = active ]
next_expiry=$(systemctl show receipt-codex-expiry.timer -p NextElapseUSecRealtime --value)
[ -n "$next_expiry" ] && [ "$next_expiry" != 0 ]
systemctl reload ssh || systemctl reload sshd
'@
$remote=$remote.Replace('__HOURS__',[string]$LifetimeHours)
$remote=$remote.Replace('__PUBLIC_KEY_B64__',$pubB64)
$remote=$remote.Replace('__REMOTE_HELPER__',$remoteHelper)
$remote=$remote.Replace('__EXPECTED_FINGERPRINT__',$localFingerprint)
try{
    $bootstrapResult=Invoke-SshPayload 'ssh.exe' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-i',$PermanentKey,"root@$SshAddress",'bash -s') $remote
    if($bootstrapResult.ExitCode -ne 0){throw 'Remote bootstrap failed'}
}catch{
    $cleanupResult=Invoke-SshPayload 'ssh.exe' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-i',$PermanentKey,"root@$SshAddress","rm -f '$remoteHelper'") ''
    throw
}
$currentSid=([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
function Set-TemporaryAccessAcl([string]$Path,[bool]$Directory){
    $target=if($Directory){New-Object System.IO.DirectoryInfo($Path)}else{New-Object System.IO.FileInfo($Path)}
    $acl=$target.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true,$false)
    # Remove exact existing ACEs without coercing extended Windows rights masks.
    foreach($existing in @($acl.Access)) {[void]$acl.RemoveAccessRuleSpecific($existing)}
    $inheritance=if($Directory){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None}
    $propagation=[Security.AccessControl.PropagationFlags]::None
    foreach($sidValue in @($currentSid,'S-1-5-18','S-1-5-32-544')){
        $sid=New-Object System.Security.Principal.SecurityIdentifier($sidValue)
        $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,$propagation,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    $target.SetAccessControl($acl)
}
Set-TemporaryAccessAcl $accessDir $true
Set-TemporaryAccessAcl $privateKey $false
Set-TemporaryAccessAcl $publicKey $false
if(-not(Test-Path -LiteralPath $privateKey -PathType Leaf) -or -not(Test-Path -LiteralPath $publicKey -PathType Leaf)){throw 'Temporary access key ACL validation failed'}
$credentialResult=Invoke-SshPayload 'ssh.exe' @('-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-i',$privateKey,"codex-receipt@$SshAddress",'capabilities') ''
if($credentialResult.ExitCode -ne 0){throw 'Temporary SSH credential validation failed'}
Write-Output 'Temporary Codex VPS access installed with automatic expiry.'
