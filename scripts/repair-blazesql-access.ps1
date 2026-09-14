[CmdletBinding()]
param(
    [string]$Server = $env:FINANCE_VPS_HOST,
    [string]$RootKeyPath = $env:FINANCE_VPS_SSH_KEY
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Server) -or [string]::IsNullOrWhiteSpace($RootKeyPath)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
$secretDir = (Join-Path $PSScriptRoot '..\.blazesql' | Resolve-Path).ProviderPath
$passwordFile = [IO.Path]::GetFullPath((Join-Path ([string]$secretDir) 'blazesql_db_password.txt'))
$keyFile = [IO.Path]::GetFullPath((Join-Path ([string]$secretDir) 'blazesql_key.pem'))
$rootKey = [IO.Path]::GetFullPath($RootKeyPath)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from PowerShell started with Run as administrator.'
}
if (-not (Test-Path -LiteralPath $rootKey)) { throw "Root SSH key not found: $rootKey" }

$currentSid = $identity.User.Value

# First take ownership as Administrators; this also repairs a directory whose
# previous ACL denies access to the current interactive user.
& takeown.exe /F $secretDir /R /A /D Y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to take ownership of the secret directory. Run an elevated PowerShell.' }

& icacls.exe $secretDir /inheritance:r /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable inherited NTFS permissions.' }

# Removal may return non-zero when an entry is already absent, so verify the
# resulting allow-list using the grant operation and direct file access below.
& icacls.exe $secretDir /remove:g '*S-1-1-0' '*S-1-5-32-545' /T /C | Out-Null
& icacls.exe $secretDir /remove:d '*S-1-1-0' '*S-1-5-32-545' /T /C | Out-Null
& icacls.exe $secretDir /grant:r "*${currentSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to set NTFS ACL.' }

if (-not (Test-Path -LiteralPath $passwordFile)) { throw 'Password file is not accessible after ACL repair.' }
if (-not (Test-Path -LiteralPath $keyFile)) { throw 'Private key is not accessible after ACL repair.' }

# Make the two existing files writable/readable before rotating the password.
& icacls.exe $passwordFile /inheritance:r /remove:d '*S-1-1-0' '*S-1-5-32-545' /grant:r "*${currentSid}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare the password file permissions.' }
& icacls.exe $keyFile /inheritance:r /remove:d '*S-1-1-0' '*S-1-5-32-545' /grant:r "*${currentSid}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare the private key permissions.' }

$chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
}
finally {
    $rng.Dispose()
}
$password = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
$temporaryPasswordFile = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($temporaryPasswordFile, $password, (New-Object Text.UTF8Encoding($false)))
    $sql = "ALTER ROLE chatgpt_reader PASSWORD '$password';"
    $sql | ssh -o BatchMode=yes -i $rootKey "root@$Server" "sudo -u postgres psql -d finance_receipt_collector -v ON_ERROR_STOP=1" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Database password rotation failed.' }
    Copy-Item -LiteralPath $temporaryPasswordFile -Destination $passwordFile -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryPasswordFile) {
        Remove-Item -LiteralPath $temporaryPasswordFile -Force -ErrorAction SilentlyContinue
    }
}

& icacls.exe $passwordFile /inheritance:r /grant:r "*${currentSid}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the password file.' }
& icacls.exe $keyFile /inheritance:r /grant:r "*${currentSid}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the private key.' }
if (-not (Get-Content -LiteralPath $passwordFile -Raw)) { throw 'Password file verification failed.' }
if ((Get-Item -LiteralPath $keyFile).Length -le 0) { throw 'Private key verification failed.' }
Write-Output 'BlazeSQL ACL fixed and PostgreSQL password rotated. Secrets were not printed.'
