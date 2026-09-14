[CmdletBinding()]
param(
    [string]$KeyPath = $env:FINANCE_VPS_SSH_KEY,
    [string]$HostName = $env:FINANCE_VPS_HOST,
    [string]$SshUser = 'root',
    [int]$LocalPort = 13389,
    [string]$RdpUser = 'fnslogin',
    [switch]$ResetCredential
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($KeyPath) -or [string]::IsNullOrWhiteSpace($HostName)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
$credentialTargets = @(
    'TERMSRV/127.0.0.1',
    "TERMSRV/127.0.0.1:$LocalPort"
)
$sshErrorPath = Join-Path $env:TEMP 'finance-receipt-collector-ssh.err'
$sshProcess = $null

if (-not (Test-Path -LiteralPath $KeyPath)) {
    throw "SSH key was not found: $KeyPath"
}

try {
    try { if (Test-Path -LiteralPath $sshErrorPath) { Remove-Item -LiteralPath $sshErrorPath -Force -ErrorAction Stop } } catch { }
    if ($ResetCredential) {
        @(
            $credentialTargets,
            'TERMSRV/localhost',
            "TERMSRV/localhost:$LocalPort"
        ) | Select-Object -Unique | ForEach-Object {
            & cmdkey.exe /delete:$_ 2>$null | Out-Null
        }
    }
    $credentialEntry = $credentialTargets | Where-Object {
        cmdkey.exe /list:$_ 2>$null | Select-String -SimpleMatch $_
    }
    if (-not $credentialEntry) {
        $credential = Get-Credential -UserName $RdpUser -Message "Enter the temporary RDP password once. Windows Credential Manager will store it securely."
        if ($credential.UserName -ne $RdpUser) {
            throw "Use the RDP username '$RdpUser'."
        }
        $password = $credential.GetNetworkCredential().Password
        foreach ($credentialTarget in $credentialTargets) {
            & cmdkey.exe /generic:$credentialTarget /user:$RdpUser /pass:$password | Out-Null
        }
        Remove-Variable password -ErrorAction SilentlyContinue
    }

    $sshArgs = @(
        '-i', $KeyPath,
        '-N',
        '-L', "${LocalPort}:127.0.0.1:3389",
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=30',
        "$SshUser@$HostName"
    )
    $sshProcess = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArgs -WindowStyle Hidden -RedirectStandardError $sshErrorPath -PassThru

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-NetConnection -ComputerName 127.0.0.1 -Port $LocalPort -InformationLevel Quiet) { break }
        if ($sshProcess.HasExited) {
            $detail = if (Test-Path -LiteralPath $sshErrorPath) { (Get-Content -LiteralPath $sshErrorPath -Raw).Trim() } else { '' }
            throw "SSH tunnel exited before the RDP port became available. $detail"
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port $LocalPort -InformationLevel Quiet)) {
        throw 'SSH tunnel did not become ready.'
    }

    Start-Process -FilePath 'mstsc.exe' -ArgumentList @(
        "/v:127.0.0.1:$LocalPort",
        '/w:1024',
        '/h:768'
    ) -Wait
}
finally {
    if ($sshProcess -and -not $sshProcess.HasExited) {
        Stop-Process -Id $sshProcess.Id -Force
    }
    try { if (Test-Path -LiteralPath $sshErrorPath) { Remove-Item -LiteralPath $sshErrorPath -Force -ErrorAction Stop } } catch { }
}
