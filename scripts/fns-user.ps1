[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)] [ValidateSet('add','import-profile','finish','status','retry','disable','enable','browser-start','browser-stop')] [string]$Command,
    [Parameter(Position = 1)] [string]$Name,
    [string]$KeyPath = $env:FINANCE_VPS_SSH_KEY,
    [string]$HostName = $env:FINANCE_VPS_HOST,
    [string]$SshUser = 'root',
    [string]$RemoteProject = '/opt/accountant/receipt-collector',
    [int]$LocalPort = 13389,
    [string]$RdpUser = 'fnslogin',
    [switch]$FreshProfile,
    [switch]$NoGui
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($KeyPath) -or [string]::IsNullOrWhiteSpace($HostName)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key was not found: $KeyPath" }
if ($Command -ne 'status' -and [string]::IsNullOrWhiteSpace($Name)) { throw "$Command requires a name or source id" }
if ($FreshProfile -and $Command -ne 'add') { throw '-FreshProfile is valid only with add' }

function Quote-Posix([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function New-RemoteCliCommand([string]$Action, [string]$ActionName) {
    $parts = @(
        'systemd-run', '--quiet', '--wait', '--pipe', '--collect',
        '--property=User=receiptcollector',
        '--property=Group=receiptcollector',
        ("--property=WorkingDirectory=" + $RemoteProject),
        '--property=EnvironmentFile=/etc/finance-receipt-collector/receipt-collector.env',
        '--', '/usr/bin/node', ($RemoteProject.TrimEnd('/') + '/bin/receipt-collector.js'), 'fns-user', $Action
    )
    if ($ActionName) { $parts += $ActionName }
    return (($parts | ForEach-Object { Quote-Posix $_ }) -join ' ')
}

$remoteArgs = @('-i', $KeyPath, "$SshUser@$HostName", (New-RemoteCliCommand $Command $Name))

if (@('add','import-profile') -notcontains $Command) {
    & ssh.exe @remoteArgs
    exit $LASTEXITCODE
}

$stateUsersPath = $RemoteProject.TrimEnd('/') + '/.receipt-collector/users'
$quotedStateUsersPath = Quote-Posix $stateUsersPath
$configPath = '/etc/finance-receipt-collector/fns-sources.json'
$configBackupPath = $configPath + '.bak'
$statePrepCommand = 'install -d -o receiptcollector -g receiptcollector -m 0700 ' + $quotedStateUsersPath + ' && chown receiptcollector:receiptcollector ' + $quotedStateUsersPath + ' && chmod 0700 ' + $quotedStateUsersPath + ' && for d in ' + $stateUsersPath + '/fns-onboarding-*; do if [ -d "$d" ]; then chown -R receiptcollector:receiptcollector "$d"; fi; done && if [ -f ' + $configPath + ' ]; then chown receiptcollector:receiptcollector ' + $configPath + ' && chmod 0600 ' + $configPath + '; fi && if [ -e ' + $configBackupPath + ' ]; then chown receiptcollector:receiptcollector ' + $configBackupPath + ' && chmod 0600 ' + $configBackupPath + '; fi'
& ssh.exe @('-i', $KeyPath, "$SshUser@$HostName", $statePrepCommand)
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare onboarding state directory' }

$displayPrepCommand = 'set -eu; sudo -n -u fnslogin env DISPLAY=:10 XAUTHORITY=/home/fnslogin/.Xauthority xhost +SI:localuser:receiptcollector >/dev/null; for pid in $(pgrep -u fnslogin -f -- ''--user-data-dir=/home/fnslogin/chrome-profile'' || true); do case $pid in *[!0-9]*) exit 1;; esac; kill $pid 2>/dev/null || true; done; sleep 1; for pid in $(pgrep -u fnslogin -f -- ''--user-data-dir=/home/fnslogin/chrome-profile'' || true); do case $pid in *[!0-9]*) exit 1;; esac; kill -9 $pid 2>/dev/null || true; done; rm -rf -- /home/fnslogin/chrome-profile; install -d -o fnslogin -g fnslogin -m 0700 -- /home/fnslogin/chrome-profile'

if ($Command -eq 'add') {
    $digestBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Name.Trim()))
    $digest = ([BitConverter]::ToString($digestBytes) -replace '-', '').ToLowerInvariant().Substring(0, 16)
    $profilePath = "$RemoteProject/.receipt-collector/users/fns-onboarding-$digest/chromium-profile"
    $profilePidPath = "$RemoteProject/.receipt-collector/users/fns-onboarding-$digest/chromium.pid"
    $profileRoot = "$RemoteProject/.receipt-collector/users"
    $profileSourceDir = "$profileRoot/fns-onboarding-$digest"
    $profileResetCommand = 'profile=' + (Quote-Posix $profilePath) + '; sourcedir=' + (Quote-Posix $profileSourceDir) + '; pidfile=' + (Quote-Posix $profilePidPath) + '; case $profile in ' + $profileRoot + '/fns-onboarding-*/chromium-profile) ;; *) echo UNSAFE_PROFILE_PATH >&2; exit 1;; esac; [ -n $profile ] || exit 1; [ $profile != / ] || exit 1; [ $profile != /home ] || exit 1; if [ -f $pidfile ]; then pid=$(cat $pidfile); case $pid in *[!0-9]*) echo INVALID_ONBOARDING_PID >&2; exit 1;; esac; kill $pid 2>/dev/null || true; sleep 1; if kill -0 $pid 2>/dev/null; then kill -9 $pid 2>/dev/null || true; fi; rm -f $pidfile; fi; rm -rf -- $profile; [ ! -e $profile ] || exit 1; find $sourcedir -maxdepth 1 -mindepth 1 -type d -name ''chromium-profile-previous-*'' -exec rm -rf -- {} +; install -d -o receiptcollector -g receiptcollector -m 0700 -- $profile'
    & ssh.exe @('-i', $KeyPath, "$SshUser@$HostName", $profileResetCommand)
    if ($LASTEXITCODE -ne 0) { throw 'Could not reset the onboarding Chromium profile' }
}

if (@('add','import-profile') -notcontains $Command) {
    & ssh.exe @remoteArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if ($NoGui) { Write-Host 'Onboarding state and clean profile prepared; GUI start was skipped.'; exit 0 }

$credentialTargets = @("TERMSRV/127.0.0.1", "TERMSRV/127.0.0.1:$LocalPort")
$credentialEntry = $credentialTargets | Where-Object { cmdkey.exe /list:$_ 2>$null | Select-String -SimpleMatch $_ }
if (-not $credentialEntry) {
    $credential = Get-Credential -UserName $RdpUser -Message 'Enter the temporary RDP password. Windows Credential Manager will store it securely.'
    if ($credential.UserName -ne $RdpUser) { throw "Use the RDP username '$RdpUser'." }
    $password = $credential.GetNetworkCredential().Password
    foreach ($target in $credentialTargets) { cmdkey.exe /generic:$target /user:$RdpUser /pass:$password | Out-Null }
    Remove-Variable password -ErrorAction SilentlyContinue
}

$tempRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
$errorPath = Join-Path $tempRoot 'fns-user-ssh.err'
$sshProcess = Start-Process -FilePath 'ssh.exe' -ArgumentList @('-i', $KeyPath, '-N', '-L', "${LocalPort}:127.0.0.1:3389", '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', "$SshUser@$HostName") -WindowStyle Hidden -RedirectStandardError $errorPath -PassThru
$rdpProcess = $null
$remoteCliProcess = $null
$cliOutputPath = Join-Path $tempRoot 'fns-user-remote.out'
$cliErrorPath = Join-Path $tempRoot 'fns-user-remote.err'
try {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-NetConnection -ComputerName 127.0.0.1 -Port $LocalPort -InformationLevel Quiet) { break }
        if ($sshProcess.HasExited) { throw "SSH tunnel failed: $((Get-Content -LiteralPath $errorPath -Raw -ErrorAction SilentlyContinue).Trim())" }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port $LocalPort -InformationLevel Quiet)) { throw 'SSH tunnel did not become ready.' }
    $rdpProcess = Start-Process -FilePath 'mstsc.exe' -ArgumentList @("/v:127.0.0.1:$LocalPort", '/w:1024', '/h:768') -PassThru
    $displayReady = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & ssh.exe @('-o', 'ConnectTimeout=2', '-i', $KeyPath, "$SshUser@$HostName", $displayPrepCommand) 2>$null
        $displayExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorAction
        if ($displayExitCode -eq 0) { $displayReady = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $displayReady) { throw 'RDP display did not become ready.' }
    if (@('add','import-profile') -contains $Command) {
        $remoteCliProcess = Start-Process -FilePath 'ssh.exe' -ArgumentList @('-i', $KeyPath, "$SshUser@$HostName", (New-RemoteCliCommand $Command $Name)) -WindowStyle Hidden -RedirectStandardOutput $cliOutputPath -RedirectStandardError $cliErrorPath -PassThru
        if ($Command -eq 'add') {
            Write-Host 'Complete FNS login in the remote Chromium/RDP session. Close only the login window; import will continue automatically.'
        } else {
            Write-Host 'The saved onboarding profile is being imported. Do not close Chromium; it will close automatically after validation.'
        }
    } else {
        & ssh.exe @('-i', $KeyPath, "$SshUser@$HostName", (New-RemoteCliCommand 'browser-start' $Name))
        if ($LASTEXITCODE -ne 0) { throw 'Could not start onboarding Chromium.' }
    }
    Wait-Process -Id $rdpProcess.Id
    if ($remoteCliProcess) {
        Wait-Process -Id $remoteCliProcess.Id
        if ($remoteCliProcess.ExitCode -ne 0) {
            $diagnostic = (Get-Content -LiteralPath $cliErrorPath -Raw -ErrorAction SilentlyContinue).Trim()
            throw "FNS onboarding failed: $diagnostic"
        }
        Get-Content -LiteralPath $cliOutputPath -ErrorAction SilentlyContinue
    }
}
finally {
    if ($rdpProcess -and -not $rdpProcess.HasExited) { Stop-Process -Id $rdpProcess.Id -Force }
    if ($sshProcess -and -not $sshProcess.HasExited) { Stop-Process -Id $sshProcess.Id -Force }
    if ($remoteCliProcess -and -not $remoteCliProcess.HasExited) { Stop-Process -Id $remoteCliProcess.Id -Force }
    try {
        Remove-Item -LiteralPath $errorPath,$cliOutputPath,$cliErrorPath -Force -ErrorAction SilentlyContinue
    } catch { }
}
