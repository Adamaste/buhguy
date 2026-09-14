param(
    [string]$HostName = $env:FINANCE_VPS_HOST,
    [string]$KeyPath = $env:FINANCE_VPS_SSH_KEY
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($HostName) -or [string]::IsNullOrWhiteSpace($KeyPath)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
$role = 'fns_detail_clone_runner_20260909'
$database = 'fns_detail_unavailable_clone_20260909'
$key = $KeyPath

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes).Replace('+', 'x').Replace('/', 'y').Replace('=', 'z')
"ALTER ROLE $role PASSWORD '$password';" | & ssh -i $key "root@$HostName" 'runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d postgres' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set disposable clone role password.' }

$tunnel = Start-Process ssh -ArgumentList @('-i', $key, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', "15432`:127.0.0.1`:5432", "root@$HostName") -PassThru -WindowStyle Hidden
try {
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        $ready = (Test-NetConnection 127.0.0.1 -Port 15432 -WarningAction SilentlyContinue).TcpTestSucceeded
        if ($ready) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'SSH tunnel did not become ready.' }
    $env:TEST_DATABASE_URL = "postgresql://$role`:$password@127.0.0.1`:15432/$database"
    node .\scripts\run-fns-detail-unavailable-final-clone.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Final clone verification failed.' }
}
finally {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
}
