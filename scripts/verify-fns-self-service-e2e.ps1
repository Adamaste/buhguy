[CmdletBinding()]
param(
    [Alias('Host')][string]$SshAddress = $env:FINANCE_VPS_HOST,
    [string]$SshKey = $null,
    [switch]$UseCodexAccess,
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($SshAddress)) { throw 'FINANCE_VPS_HOST is required' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$codexAccessKey = Join-Path $projectRoot '.codex-access\finance-codex-temp'
$codexAccessEnabled = $UseCodexAccess -or (Test-Path -LiteralPath $codexAccessKey -PathType Leaf)
if ([string]::IsNullOrWhiteSpace($SshKey)) { $SshKey = if ($codexAccessEnabled) { $codexAccessKey } else { $env:FINANCE_VPS_SSH_KEY } }
if ([string]::IsNullOrWhiteSpace($SshKey)) { throw 'FINANCE_VPS_SSH_KEY is required unless -UseCodexAccess is specified' }
$unicodeUserProfile = [Environment]::GetEnvironmentVariable('USERPROFILE', 'Process')
if ([string]::IsNullOrWhiteSpace($unicodeUserProfile)) { throw 'USERPROFILE is not set' }
$runnerTempRoot = Join-Path $unicodeUserProfile 'AppData\Local\Temp'
if (-not (Test-Path -LiteralPath $runnerTempRoot -PathType Container)) {
    $runnerTempRoot = Join-Path $projectRoot '.tmp\fns-self-service-e2e'
}
[IO.Directory]::CreateDirectory($runnerTempRoot) | Out-Null
$reportRoot = Join-Path $projectRoot 'artifacts\fns-self-service-final-e2e'
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ').ToLowerInvariant()
$cloneDb = "finance_receipt_collector_selfservice_e2e_$timestamp"
$cloneRole = "selfservice_e2e_$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
$localPort = Get-Random -Minimum 15432 -Maximum 15999
$remoteProject = '/opt/accountant/receipt-collector'
$sshUser = if ($codexAccessEnabled) { 'codex-receipt' } else { 'root' }
$sshProcess = $null
$testLog = $null
$requiredSchemaTables = @(
    'schema_migrations',
    'receipts', 'receipt_items', 'receipt_raw', 'sync_state',
    'receipt_fiscal_facts', 'receipt_item_fiscal_facts', 'normalization_issues',
    'accounting_scopes', 'business_event_types', 'business_event_relations',
    'business_graph_rules', 'business_graph_runs', 'business_events',
    'business_event_evidence', 'business_event_edges', 'business_event_allocations',
    'ledger_accounts', 'ledger_entries', 'ledger_postings', 'ledger_source_links',
    'reconciliation_runs', 'reconciliation_results', 'certification_facts',
    'persons', 'fns_sources', 'fns_source_person', 'receipt_source_observations',
    'fns_source_sync_state', 'fns_source_receipt_refs'
)
$script:sshCommand = $null
$script:nodeCommand = $null
$script:npmCli = $null
$report = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString('o')
    verdict = 'NOT_READY'
    exitCode = 0
    safety = [ordered]@{}
    candidateHashes = [ordered]@{}
    vps = [ordered]@{}
    production = [ordered]@{ mutated = $false; schemaRequired = $requiredSchemaTables; schemaPresent = @(); schemaMissing = @(); migrations = @() }
    backup = [ordered]@{ status = 'NOT_RUN' }
    clone = [ordered]@{ database = $cloneDb; role = $cloneRole; created = $false; roleVerified = $false; restored = $false; privilegesConfigured = $false; rolePreflight = 'NOT_RUN'; cleaned = $false; schemaRequired = $requiredSchemaTables; schemaPresent = @(); schemaMissing = @(); migrations = @() }
    tests = [ordered]@{}
    localExecution = [ordered]@{ projectWorkingDirectory = $projectRoot }
    syntheticE2E = [ordered]@{ status = 'NOT_RUN' }
    gui = [ordered]@{ status = 'NOT_RUN'; rdpProfileProof = 'NOT_RUN'; cleanup = 'NOT_RUN' }
    secretAudit = [ordered]@{ status = 'NOT_RUN' }
    remoteFailure = $null
    remoteCommands = @()
    cleanup = [ordered]@{ status = 'PENDING'; leftovers = @() }
}

function Add-ReportFailure([string]$Message) { $report.safety.failure = $Message; throw $Message }
function Resolve-NativeCommandPath([string]$Name, [string]$Path) {
    $extension = [IO.Path]::GetExtension($Path)
    if ($extension -notin @('.ps1', '.cmd', '.bat')) { return $Path }
    $base = [IO.Path]::ChangeExtension($Path, $null)
    foreach ($candidate in @("$base.cmd", "$base.exe", "$base.bat")) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    Add-ReportFailure "No native executable shim found for $Name"
}
function Resolve-Cli([string]$Name) {
    try { $command = Get-Command -Name $Name -ErrorAction Stop }
    catch { Add-ReportFailure "Required local command is missing: $Name" }
    if ($command.CommandType -notin @('Application','ExternalScript')) { Add-ReportFailure "Resolved command is not an executable/script: $Name" }
    $path = if ($command.Path) { $command.Path } else { $command.Source }
    if ([string]::IsNullOrWhiteSpace($path)) { Add-ReportFailure "Resolved command has no executable path: $Name" }
    return Resolve-NativeCommandPath $Name $path
}
function Resolve-NpmCli([string]$NodePath) {
    $nodeDirectory = Split-Path -Parent $NodePath
    $standardCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    if (Test-Path -LiteralPath $standardCli -PathType Leaf) { return $standardCli }
    try { $npmCmd = Get-Command npm.cmd -CommandType Application -ErrorAction Stop } catch { $npmCmd = $null }
    if ($null -ne $npmCmd) {
        $npmCmdPath = if ($npmCmd.Path) { $npmCmd.Path } else { $npmCmd.Source }
        if (-not [string]::IsNullOrWhiteSpace($npmCmdPath)) {
            $npmRoot = Split-Path -Parent $npmCmdPath
            $fallbackCli = Join-Path $npmRoot 'node_modules\npm\bin\npm-cli.js'
            if (Test-Path -LiteralPath $fallbackCli -PathType Leaf) { return $fallbackCli }
        }
    }
    Add-ReportFailure 'NPM_CLI_NOT_FOUND'
}
function ConvertTo-WindowsProcessArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (2 * $slashes + 1)))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}
function Invoke-NativeProcess([string]$File, [string[]]$Arguments, [string]$InputText = $null, [hashtable]$EnvironmentVariables = $null, [string]$WorkingDirectory = $null) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $File
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $startInfo.WorkingDirectory = $WorkingDirectory }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $argumentList = $startInfo.PSObject.Properties['ArgumentList']
    if ($null -ne $argumentList) {
        foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
    } else {
        $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsProcessArgument $_ }) -join ' ')
    }
    if ($null -ne $EnvironmentVariables) {
        foreach ($key in $EnvironmentVariables.Keys) { $startInfo.EnvironmentVariables[$key] = [string]$EnvironmentVariables[$key] }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Could not start native process: $File" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($null -ne $InputText) { $process.StandardInput.Write($InputText) }
        $process.StandardInput.Close()
        $process.WaitForExit()
        [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdoutTask.Result; Stderr = $stderrTask.Result }
    } finally {
        $process.Dispose()
    }
}
function Invoke-Captured([string]$File, [string[]]$Arguments, [string]$InputText = $null, [hashtable]$EnvironmentVariables = $null, [string]$WorkingDirectory = $null) {
    return Invoke-NativeProcess $File $Arguments $InputText $EnvironmentVariables $WorkingDirectory
}
function Invoke-ProjectNode([string[]]$Arguments, [string]$InputText = $null, [hashtable]$EnvironmentVariables = $null) {
    return Invoke-NativeProcess $script:nodeCommand $Arguments $InputText $EnvironmentVariables $projectRoot
}
function Invoke-Ssh([string]$Command, [string]$InputText = $null) {
    $result = Invoke-SshResult $Command $InputText
    if ($result.ExitCode -ne 0) {
        $report.remoteFailure = [ordered]@{
            commandClass = Get-RemoteCommandClass $Command
            exitCode = $result.ExitCode
            stderr = Sanitize-RemoteError $result.Stderr
        }
        Add-ReportFailure "SSH read-only/clone command failed: $($report.remoteFailure.commandClass)"
    }
    return $result.Stdout.Trim()
}
function Invoke-CheckedSshResult([string]$CommandClass, [string]$Command, [string]$InputText = $null) {
    if ($codexAccessEnabled -and $CommandClass -eq 'BACKUP_VALIDATION') {
        $Command = 'backup-validate'
    }
    $result = Invoke-SshResult $Command $InputText
    $safeResult = [ordered]@{
        commandClass = $CommandClass
        exitCode = $result.ExitCode
        stdout = Sanitize-RemoteError $result.Stdout
        stderr = Sanitize-RemoteError $result.Stderr
    }
    $report.remoteCommands += $safeResult
    if ($result.ExitCode -ne 0) {
        $report.remoteFailure = $safeResult
        Add-ReportFailure "Remote PostgreSQL command failed: $CommandClass"
    }
    return $result
}
function Invoke-SshResult([string]$Command, [string]$InputText = $null) {
    if ($codexAccessEnabled) {
        $Command = Get-CodexRemoteCommand $Command
    }
    $args = @('-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=accept-new','-i',$SshKey,"$sshUser@$SshAddress",$Command)
    $result = Invoke-Captured $script:sshCommand $args $InputText
    return $result
}
function Get-CodexRemoteCommand([string]$Command) {
    if ($Command -match '^capabilities$|command -v chromium|ss -lnt') { return 'capabilities' }
    if ($Command -match '^(production-identity|production-schema|production-migrations|backup-validate)$') { return $Command }
    if ($Command -match '^clone-(restore-status|exists|role-exists)$') { return $Command }
    if ($Command -match '^clone-(role-create|role-verify|db-create|db-verify|restore|grant|query|drop) [a-z][a-z0-9_]+(?: [a-z][a-z0-9_]+)?$') { return $Command }
    if ($Command -match 'BACKUP_VALIDATION|/var/backups/receipt-collector/postgres.*pg_restore --list') { return 'backup-validate' }
    if ($Command -match 'PRODUCTION_DATABASE_IDENTITY') { return 'production-identity' }
    if ($Command -match 'PRODUCTION_SCHEMA') { return 'production-schema' }
    if ($Command -match 'PRODUCTION_MIGRATIONS') { return 'production-migrations' }
    if ($Command -match 'CLONE_SCHEMA') { return "clone-query $cloneDb schema" }
    if ($Command -match 'CLONE_MIGRATIONS') { return "clone-query $cloneDb migrations" }
    if ($Command -match 'VERIFY_CLONE_RESTORE|VERIFY_CLONE_GRANT_DATABASE') { return "clone-query $cloneDb identity" }
    if ($Command -match 'VERIFY_CLONE_DATABASE') { return "clone-db-verify $cloneDb" }
    if ($Command -match 'VERIFY_CLONE_ROLE') { return "clone-role-verify $cloneRole" }
    if ($Command -match 'CLEANUP_VERIFY_DATABASE') { return "clone-query $cloneDb identity" }
    if ($Command -match 'CLEANUP_VERIFY_ROLE') { return "clone-role-verify $cloneRole" }
    if ($Command -match 'createdb') { return "clone-db-create $cloneDb $cloneRole" }
    if ($Command -match 'pg_restore') { return "clone-restore $cloneDb" }
    if ($Command -match 'dropdb|dropuser') { return "clone-drop $cloneDb $cloneRole" }
    Add-ReportFailure "Codex remote capability is not allowlisted: $Command"
}
function Quote-Posix([string]$Value) {
    $singleQuoteEscape = "'" + [char]34 + "'" + [char]34 + "'"
    return "'" + $Value.Replace("'", $singleQuoteEscape) + "'"
}
function ConvertTo-SqlLiteral([string]$Value) {
    if ($null -eq $Value) { throw 'SQL literal value cannot be null' }
    return "'" + $Value.Replace("'", "''") + "'"
}
function ConvertTo-SqlIdentifier([string]$Value) {
    if ($Value -notmatch '^[a-z][a-z0-9_]*$') { throw "Unsafe generated SQL identifier: $Value" }
    return '"' + $Value.Replace('"', '""') + '"'
}
function Invoke-RemoteCommand([string]$RemoteCommand, [string]$InputText = $null) {
    # $RemoteCommand is deliberately the final single element of $args.
    return Invoke-SshResult $RemoteCommand $InputText
}
function Invoke-RemotePsql([string]$CommandClass, [string]$Sql, [string]$Database = 'finance_receipt_collector') {
    if ($Database -notmatch '^[a-z][a-z0-9_]*$') { throw "Unsafe remote database name: $Database" }
    if ($codexAccessEnabled) {
        if ($CommandClass -eq 'PRODUCTION_DATABASE_IDENTITY') { $remoteCommand = 'production-identity'; $input = $null }
        elseif ($CommandClass -match '^PRODUCTION_SCHEMA$') { $remoteCommand = 'production-schema'; $input = $null }
        elseif ($CommandClass -match '^PRODUCTION_MIGRATIONS$') { $remoteCommand = 'production-migrations'; $input = $null }
        elseif ($CommandClass -eq 'CREATE_CLONE_ROLE') { $remoteCommand = "clone-role-create $cloneRole"; $input = ([regex]::Match($Sql, "PASSWORD '([^']*)'").Groups[1].Value.Replace("''", "'")) + "`n" }
        elseif ($CommandClass -eq 'VERIFY_CLONE_ROLE') { $remoteCommand = "clone-role-verify $cloneRole"; $input = $null }
        elseif ($CommandClass -match 'CLONE_SCHEMA') { $remoteCommand = "clone-query $Database schema"; $input = $null }
        elseif ($CommandClass -match 'CLONE_MIGRATIONS') { $remoteCommand = "clone-query $Database migrations"; $input = $null }
        elseif ($CommandClass -match 'VERIFY_CLONE_DATABASE|VERIFY_CLONE_RESTORE|VERIFY_CLONE_GRANT_DATABASE') { $remoteCommand = "clone-query $cloneDb identity"; $input = $null }
        elseif ($CommandClass -match 'CLEANUP_VERIFY_DATABASE') { $remoteCommand = 'clone-exists'; $input = $null }
        elseif ($CommandClass -match 'CLEANUP_VERIFY_ROLE') { $remoteCommand = 'clone-role-exists'; $input = $null }
        else { Add-ReportFailure "Codex PostgreSQL capability is not allowlisted: $CommandClass" }
        $result = Invoke-RemoteCommand $remoteCommand $input
    } else {
        $remoteCommand = "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d $(Quote-Posix $Database) -Atq"
        $result = Invoke-RemoteCommand $remoteCommand $Sql
    }
    $safeResult = [ordered]@{
        commandClass = $CommandClass
        exitCode = $result.ExitCode
        stdout = Sanitize-RemoteError $result.Stdout
        stderr = Sanitize-RemoteError $result.Stderr
    }
    $report.remoteCommands += $safeResult
    return $result
}
function Assert-RemotePsql([string]$CommandClass, [string]$Sql, [string]$Database = 'finance_receipt_collector') {
    $result = Invoke-RemotePsql $CommandClass $Sql $Database
    if ($result.ExitCode -ne 0) {
        $report.remoteFailure = $report.remoteCommands[-1]
        Add-ReportFailure "Remote PostgreSQL command failed: $CommandClass"
    }
    return $result
}
function Invoke-CloneGrant([string]$CommandClass, [string]$Sql) {
    if ($codexAccessEnabled) {
        $result = Invoke-RemoteCommand "clone-grant $cloneDb $cloneRole"
        $safeResult = [ordered]@{ commandClass=$CommandClass; exitCode=$result.ExitCode; stdout=Sanitize-RemoteError $result.Stdout; stderr=Sanitize-RemoteError $result.Stderr }
        $report.remoteCommands += $safeResult
        if ($result.ExitCode -ne 0) { $report.remoteFailure=$safeResult; Add-ReportFailure "Remote PostgreSQL command failed: $CommandClass" }
        return $result
    }
    $identity = Assert-RemotePsql "${CommandClass}_DATABASE_IDENTITY" 'SELECT current_database();' $cloneDb
    if ($identity.Stdout.Trim() -cne $cloneDb) {
        Add-ReportFailure "Clone privilege setup refused for ${CommandClass}: database identity mismatch"
    }
    return Assert-RemotePsql $CommandClass $Sql $cloneDb
}
function Get-RemoteSchemaSnapshot([string]$Scope, [string]$Database) {
    $tableLiterals = ($requiredSchemaTables | ForEach-Object { ConvertTo-SqlLiteral $_ }) -join ','
    $schemaSql = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ($tableLiterals) ORDER BY table_name;"
    $schemaResult = Assert-RemotePsql "${Scope}_SCHEMA" $schemaSql $Database
    $present = @($schemaResult.Stdout -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $missing = @($requiredSchemaTables | Where-Object { $present -notcontains $_ })
    $migrationResult = Assert-RemotePsql "${Scope}_MIGRATIONS" 'SELECT filename FROM schema_migrations ORDER BY filename;' $Database
    $migrations = @($migrationResult.Stdout -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    return [pscustomobject]@{ Required = @($requiredSchemaTables); Present = $present; Missing = $missing; Migrations = $migrations }
}
function Sanitize-RemoteError([string]$Message) {
    $safe = ($Message -replace '(?i)(password|token|secret|credential)\s*[=:]\s*[^\s]+', '$1=[REDACTED]')
    $safe = ($safe -replace '[\r\n]+', ' ').Trim()
    if ($safe.Length -gt 500) { $safe = $safe.Substring(0, 500) }
    return $safe
}
function Sanitize-ProcessOutput([string]$Message) {
    $safe = ($Message -replace '(?i)(accessToken|refreshToken|password|token|secret|credential|cookie)\s*[=:]\s*[^\s]+', '$1=[REDACTED]')
    if ($safe.Length -gt 50000) { $safe = $safe.Substring(0, 50000) + "`n[TRUNCATED]" }
    return $safe
}
function Get-RemoteErrorClass([string]$Message) {
    if ($Message -match '(?i)sudo:.*not found') { return 'SUDO_UNAVAILABLE' }
    if ($Message -match '(?i)peer authentication|password authentication|role .* does not exist') { return 'POSTGRES_AUTH_OR_ROLE' }
    if ($Message -match '(?i)permission denied|not permitted') { return 'REMOTE_PERMISSION_DENIED' }
    if ($Message -match '(?i)database .* does not exist') { return 'DATABASE_NOT_FOUND' }
    return 'REMOTE_PSQL_FAILED'
}
function Get-RemoteCommandClass([string]$Command) {
    if ($Command -match '(?i)\bpsql\b') { return 'POSTGRES_PSQL' }
    if ($Command -match '(?i)\bpg_restore\b') { return 'POSTGRES_PG_RESTORE' }
    if ($Command -match '(?i)\b(dropdb|dropuser|createdb|createuser)\b') { return 'POSTGRES_ADMIN' }
    return 'REMOTE_COMMAND'
}
function Get-Hash([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Invoke-NodeWithDatabase([string]$Script) {
    $old = $env:TEST_DATABASE_URL
    try { $env:TEST_DATABASE_URL = $script:databaseUrl; $result = Invoke-ProjectNode @('--input-type=module','-e',$Script); if ($result.ExitCode -ne 0) { throw $result.Stderr.Trim() }; return $result.Stdout.Trim() }
    finally { if ($null -eq $old) { Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue } else { $env:TEST_DATABASE_URL = $old } }
}

try {
    if (-not (Test-Path -LiteralPath $projectRoot -PathType Container)) { Add-ReportFailure 'Project root is invalid' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json') -PathType Leaf)) { Add-ReportFailure 'package.json is missing' }
    $pgPackageJson = Join-Path $projectRoot 'node_modules\pg\package.json'
    if (-not (Test-Path -LiteralPath $pgPackageJson -PathType Leaf)) { Add-ReportFailure 'PROJECT_PG_DEPENDENCY_NOT_FOUND' }
    if ($cloneDb -notmatch '^[a-z][a-z0-9_]*$') { Add-ReportFailure 'Generated clone database name is unsafe' }
    if ($cloneRole -notmatch '^[a-z][a-z0-9_]*$') { Add-ReportFailure 'Generated clone role name is unsafe' }
    $script:sshCommand = Resolve-Cli 'ssh'
    $script:nodeCommand = Resolve-Cli 'node'
    $report.safety.resolvedCommands = [ordered]@{ ssh = $script:sshCommand; node = $script:nodeCommand; npmCli = $null }
    $script:npmCli = Resolve-NpmCli $script:nodeCommand
    $report.safety.resolvedCommands.npmCli = $script:npmCli
    if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) { Add-ReportFailure "SSH key is missing: $SshKey" }
    $report.safety.projectRoot = $projectRoot
    $report.safety.userProfile = $unicodeUserProfile
    $report.safety.tempRoot = $runnerTempRoot
    $report.safety.sshKeyPath = $SshKey
    $report.safety.sshKeyContentsPrinted = $false
    $hashFiles = @('src\fns-user-onboarding.js','src\browser-session-import.js','src\onboarding-browser.js','src\cli.js','scripts\fns-user.ps1','scripts\run-fns-self-service-clone-e2e.mjs')
    foreach ($file in $hashFiles) { $full = Join-Path $projectRoot $file; if (-not (Test-Path -LiteralPath $full)) { Add-ReportFailure "Candidate file missing: $file" }; $report.candidateHashes[$file] = Get-Hash $full }
    $remote = Invoke-Ssh @'
set -eu
printf 'hostname=%s\n' "$(hostname)"
printf 'chromium=%s\n' "$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
printf 'xrdp=%s\n' "$(command -v xrdp || true)"
printf 'xorg=%s\n' "$(command -v Xorg || true)"
printf 'rdp_listeners=%s\n' "$(ss -lnt 2>/dev/null | awk '/:3389 /{print $4}' | paste -sd, -)"
'@
    $lines = $remote -split "`n"; foreach ($line in $lines) { if ($line -match '^([^=]+)=(.*)$') { $report.vps[$Matches[1]] = $Matches[2] } }
    $identityResult = Invoke-RemotePsql 'PRODUCTION_DATABASE_IDENTITY' 'SELECT current_database();'
    $remoteDatabase = $identityResult.Stdout.Trim()
    if ($identityResult.ExitCode -ne 0) {
        $report.vps.db = ''
        $report.vps.dbErrorClass = Get-RemoteErrorClass $identityResult.Stderr
        $report.vps.dbError = Sanitize-RemoteError $identityResult.Stderr
        Add-ReportFailure "Remote PostgreSQL identity check failed: $($report.vps.dbErrorClass)"
    }
    $report.vps.db = $remoteDatabase
    if ($remoteDatabase -cne 'finance_receipt_collector') { Add-ReportFailure "Remote database identity mismatch: expected finance_receipt_collector" }
    $productionSchema = Get-RemoteSchemaSnapshot 'PRODUCTION' 'finance_receipt_collector'
    $report.production.schemaPresent = $productionSchema.Present
    $report.production.schemaMissing = $productionSchema.Missing
    $report.production.migrations = $productionSchema.Migrations
    $report.production.hasFnsSourceReceiptRefs = ($productionSchema.Present -contains 'fns_source_receipt_refs')
    if ($productionSchema.Missing.Count -gt 0) {
        $report.production.conclusion = 'RUNNER_SCHEMA_EXPECTATION_BUG'
        Add-ReportFailure "Production schema is missing required tables: $($productionSchema.Missing -join ', ')"
    }
    $guiReady = [bool]($report.vps.chromium -and $report.vps.xorg -and $report.vps.xrdp)
    $report.gui.status = if ($guiReady) { 'CAPABILITY_PRESENT' } else { 'INFRA_DEPENDENCY_MISSING' }
    if (-not $guiReady) { $report.gui.missing = @('chromium/chromium-browser/google-chrome','xrdp','Xorg') }
    # Presence of binaries is not RDP proof. The final gate remains closed until
    # the same wrapper flow proves PID/display/profile/CDP linkage.
    $report.gui.rdpProfileProof = 'NOT_RUN_BY_CODEX_RUNNER'
    $backupResult = Invoke-CheckedSshResult 'BACKUP_VALIDATION' @'
set -eu
latest=$(find /var/backups/receipt-collector/postgres -maxdepth 1 -type f -name '*.dump.gz' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
test -n "$latest"
gzip -cd "$latest" | sudo -u postgres pg_restore --list >/dev/null
sha256sum "$latest"
'@
    $report.clone.backup = $backupResult.Stdout.Trim()
    $clonePasswordBytes = New-Object byte[] 32; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($clonePasswordBytes) } finally { $rng.Dispose() }; $clonePassword = [Convert]::ToBase64String($clonePasswordBytes).TrimEnd('=').Replace('+','A').Replace('/','B')
    $safePassword = $clonePassword.Replace("'", "''")

    $roleCreate = Invoke-RemotePsql 'CREATE_CLONE_ROLE' "CREATE ROLE $(ConvertTo-SqlIdentifier $cloneRole) LOGIN PASSWORD '$safePassword';`n" 'postgres'
    $roleVerify = Assert-RemotePsql 'VERIFY_CLONE_ROLE' "SELECT rolname FROM pg_roles WHERE rolname = $(ConvertTo-SqlLiteral $cloneRole);" 'postgres'
    if ($roleVerify.Stdout.Trim() -cne $cloneRole) {
        Add-ReportFailure 'Temporary clone role verification failed'
    }
    $report.clone.roleVerified = $true

    $dbCreate = Invoke-CheckedSshResult 'CREATE_CLONE_DATABASE' "sudo -u postgres createdb --owner=$(Quote-Posix $cloneRole) $(Quote-Posix $cloneDb)"
    $dbVerify = Assert-RemotePsql 'VERIFY_CLONE_DATABASE' "SELECT datname FROM pg_database WHERE datname = $(ConvertTo-SqlLiteral $cloneDb);" 'postgres'
    if ($dbVerify.Stdout.Trim() -cne $cloneDb) {
        Add-ReportFailure 'Disposable clone database verification failed'
    }
    $report.clone.created = $true

    $restore = Invoke-CheckedSshResult 'RESTORE_CLONE_DATABASE' @"
set -euo pipefail
backup=`$(find /var/backups/receipt-collector/postgres -maxdepth 1 -type f -name '*.dump.gz' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
test -n "`$backup"
gzip -cd "`$backup" | sudo -u postgres pg_restore --no-owner --no-privileges --dbname=$(Quote-Posix $cloneDb)
"@
    $restoreVerify = Assert-RemotePsql 'VERIFY_CLONE_RESTORE' 'SELECT current_database();' $cloneDb
    if ($restoreVerify.Stdout.Trim() -cne $cloneDb) {
        Add-ReportFailure 'Clone restore database identity verification failed'
    }
    $cloneSchema = Get-RemoteSchemaSnapshot 'CLONE' $cloneDb
    $report.clone.schemaPresent = $cloneSchema.Present
    $report.clone.schemaMissing = $cloneSchema.Missing
    $report.clone.migrations = $cloneSchema.Migrations
    $report.clone.hasFnsSourceReceiptRefs = ($cloneSchema.Present -contains 'fns_source_receipt_refs')
    if ($cloneSchema.Missing.Count -gt 0) {
        $report.backup.status = 'STALE_SCHEMA'
        $report.backup.missingTables = $cloneSchema.Missing
        $report.backup.conclusion = if ($report.production.schemaMissing.Count -eq 0) { 'STALE_BACKUP' } else { 'RUNNER_SCHEMA_EXPECTATION_BUG' }
        Add-ReportFailure "Clone restore schema verification failed; missing tables: $($cloneSchema.Missing -join ', ')"
    }
    $migrationDiff = @($productionSchema.Migrations | Where-Object { $cloneSchema.Migrations -notcontains $_ }) + @($cloneSchema.Migrations | Where-Object { $productionSchema.Migrations -notcontains $_ })
    if ($migrationDiff.Count -gt 0) {
        $report.backup.status = 'STALE_SCHEMA'
        $report.backup.migrationDifference = $migrationDiff | Select-Object -Unique
        $report.backup.conclusion = 'STALE_BACKUP'
        Add-ReportFailure "Clone migration state differs from production: $($migrationDiff -join ', ')"
    }
    $report.backup.status = 'VALIDATED'
    $report.clone.restored = $true
    $cloneRoleIdentifier = ConvertTo-SqlIdentifier $cloneRole
    [void](Invoke-CloneGrant 'GRANT_CLONE_SCHEMA' "GRANT USAGE, CREATE ON SCHEMA public TO $cloneRoleIdentifier;")
    [void](Invoke-CloneGrant 'GRANT_CLONE_TABLES' "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $cloneRoleIdentifier;")
    [void](Invoke-CloneGrant 'GRANT_CLONE_SEQUENCES' "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO $cloneRoleIdentifier;")
    $report.clone.privilegesConfigured = $true
    $sshProcess = Start-Process -FilePath $script:sshCommand -ArgumentList @('-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-i',$SshKey,'-N','-L',"${localPort}:127.0.0.1:5432","$sshUser@$SshAddress") -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    $script:databaseUrl = "postgresql://$cloneRole`:$([Uri]::EscapeDataString($clonePassword))@127.0.0.1`:$localPort/$cloneDb"
    $identity = Invoke-NodeWithDatabase "import pg from 'pg'; const p=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}); const r=await p.query('SELECT current_database() AS name'); console.log(r.rows[0].name); await p.end();"
    if ($identity -ne $cloneDb) { Add-ReportFailure 'Local tunnel database identity is not the generated disposable clone' }
    try {
        $rolePreflight = Invoke-NodeWithDatabase "import pg from 'pg'; const p=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}); const db=(await p.query('SELECT current_database() AS name')).rows[0].name; const receipts=(await p.query('SELECT count(*)::int AS count FROM receipts')).rows[0].count; console.log(JSON.stringify({db,receipts})); await p.end();"
    } catch {
        $preflightMessage = Sanitize-ProcessOutput $_.Exception.Message
        $preflightObject = if ($preflightMessage -match '(?i)permission denied for (?:table|sequence|schema|function)\s+([A-Za-z0-9_.]+)') { $Matches[1] } else { $null }
        $report.clone.rolePreflight = 'FAIL'
        $report.clone.rolePreflightError = [ordered]@{ commandClass = 'CLONE_ROLE_PREFLIGHT'; code = if ($preflightMessage -match '42501|permission denied') { '42501' } else { $null }; object = $preflightObject; message = $preflightMessage }
        throw
    }
    $rolePreflightData = $rolePreflight | ConvertFrom-Json
    if ($rolePreflightData.db -cne $cloneDb) { Add-ReportFailure 'Clone role preflight refused: current_database did not match generated clone' }
    $report.clone.rolePreflight = 'PASS'
    $report.clone.rolePreflightReceipts = [int]$rolePreflightData.receipts
$testLog = Join-Path $runnerTempRoot "fns-self-service-e2e-$timestamp.log"
    $oldTestDb = $env:TEST_DATABASE_URL
    try {
        $env:TEST_DATABASE_URL = $script:databaseUrl
        $testResult = Invoke-ProjectNode @($script:npmCli, 'test') $null @{ NO_UPDATE_NOTIFIER = '1'; NPM_CONFIG_UPDATE_NOTIFIER = 'false' }
        $testCombined = $testResult.Stdout + "`n" + $testResult.Stderr
        $report.tests = [ordered]@{
            exitCode = $testResult.ExitCode
            stdout = Sanitize-ProcessOutput $testResult.Stdout
            stderr = Sanitize-ProcessOutput $testResult.Stderr
            passed = if ($testCombined -match '(?m)^# pass (\d+)') { [int]$Matches[1] } else { $null }
            failed = if ($testCombined -match '(?m)^# fail (\d+)') { [int]$Matches[1] } else { $null }
            skipped = if ($testCombined -match '(?m)^# skipped (\d+)') { [int]$Matches[1] } else { $null }
            summary = @($testCombined -split "`n" | Where-Object { $_ -match '^# (tests|pass|fail|skipped|cancelled|todo)' })
        }
        [IO.File]::WriteAllText($testLog, $testCombined, [Text.UTF8Encoding]::new($false))
        if ($testResult.ExitCode -ne 0) { throw "npm test failed with exit code $($testResult.ExitCode)" }
    } finally {
        if ($null -eq $oldTestDb) { Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue } else { $env:TEST_DATABASE_URL = $oldTestDb }
    }
    $e2eResult = Invoke-ProjectNode @('scripts\run-fns-self-service-clone-e2e.mjs') $null @{ TEST_DATABASE_URL = $script:databaseUrl }
    if ($e2eResult.ExitCode -ne 0) { throw "Synthetic E2E failed with exit code $($e2eResult.ExitCode): $(Sanitize-ProcessOutput $e2eResult.Stderr)" }
    $report.syntheticE2E = $e2eResult.Stdout.Trim() | ConvertFrom-Json
    $secretHits = @()
    if (Test-Path -LiteralPath $testLog) { $secretHits = @(Select-String -LiteralPath $testLog -Pattern '["'']?(accessToken|refreshToken|cookie|sms.?code|password)["'']?\s*[:=]\s*["''][^"'']+["'']|BEGIN (RSA|OPENSSH|EC|PRIVATE) PRIVATE KEY' -CaseSensitive:$false) }
    if ($secretHits.Count -gt 0) { throw 'Runtime secret audit detected a forbidden token/password pattern in captured output' }
    $report.secretAudit.status = 'PASS'
    $report.gui.cleanup = 'NOT_RUN_BY_CODEX_RUNNER'
    $report.cleanup.status = 'COMPLETED_CLONE_ONLY'
    $report.verdict = if ($guiReady -and $report.gui.rdpProfileProof -eq 'PASS' -and $report.syntheticE2E.pass -eq $true) { 'READY_FOR_DEPLOYMENT_CANDIDATE' } else { 'NOT_READY' }
}
catch {
    $report.verdict = 'NOT_READY'
    $report.error = $_.Exception.Message
    if ($_.Exception.Message -match 'Chromium|xrdp|Xorg') { $report.exitCode = 10 } elseif ($_.Exception.Message -match 'PostgreSQL|database|pg_restore|TEST_DATABASE') { $report.exitCode = 20 } else { $report.exitCode = 50 }
}
finally {
    if ($sshProcess -and -not $sshProcess.HasExited) { Stop-Process -Id $sshProcess.Id -Force -ErrorAction SilentlyContinue }
        if (-not $KeepArtifacts -and $testLog -and (Test-Path -LiteralPath $testLog)) { Remove-Item -LiteralPath $testLog -Force -ErrorAction SilentlyContinue }
        $remaining = @()
        $cloneDropSucceeded = $false
    try {
        $dbBeforeDrop = Invoke-RemotePsql 'CLEANUP_VERIFY_DATABASE_BEFORE' "SELECT count(*) FROM pg_database WHERE datname = $(ConvertTo-SqlLiteral $cloneDb);" 'postgres'
        if ($dbBeforeDrop.ExitCode -ne 0) {
            $remaining += 'database verification failed'
        } elseif ($dbBeforeDrop.Stdout.Trim() -eq '0') {
            $report.clone.databasePresentBeforeCleanup = $false
            } elseif ($dbBeforeDrop.Stdout.Trim() -eq '1') {
                $report.clone.databasePresentBeforeCleanup = $true
                Invoke-CheckedSshResult 'CLEANUP_DROP_CLONE_DATABASE' "sudo -u postgres dropdb --if-exists $(Quote-Posix $cloneDb)" | Out-Null
                $cloneDropSucceeded = $true
            } else { $remaining += 'database existence returned invalid value' }
    } catch { $remaining += 'database cleanup failed' }
    try {
        $roleBeforeDrop = Invoke-RemotePsql 'CLEANUP_VERIFY_ROLE_BEFORE' "SELECT count(*) FROM pg_roles WHERE rolname = $(ConvertTo-SqlLiteral $cloneRole);" 'postgres'
        if ($roleBeforeDrop.ExitCode -ne 0) {
            if (-not $cloneDropSucceeded) { $remaining += 'role verification failed' }
        } elseif ($roleBeforeDrop.Stdout.Trim() -eq '0') {
            $report.clone.rolePresentBeforeCleanup = $false
        } elseif ($roleBeforeDrop.Stdout.Trim() -eq '1') {
            $report.clone.rolePresentBeforeCleanup = $true
            Invoke-CheckedSshResult 'CLEANUP_DROP_CLONE_ROLE' "sudo -u postgres dropuser --if-exists $(Quote-Posix $cloneRole)" | Out-Null
        } elseif (-not $cloneDropSucceeded) { $remaining += 'role existence returned invalid value' }
        } catch { if (-not $cloneDropSucceeded) { $remaining += 'role cleanup failed' } }
    try {
        $dbAfterDrop = Invoke-RemotePsql 'CLEANUP_VERIFY_DATABASE_AFTER' "SELECT count(*) FROM pg_database WHERE datname = $(ConvertTo-SqlLiteral $cloneDb);" 'postgres'
        if ($dbAfterDrop.ExitCode -ne 0 -and -not $cloneDropSucceeded) { $remaining += 'database verification failed' }
        elseif (-not $cloneDropSucceeded -and $dbAfterDrop.Stdout.Trim() -ne '0') { $remaining += "database remains: $cloneDb" }
    } catch { if (-not $cloneDropSucceeded) { $remaining += 'database verification failed' } }
    try {
        $roleAfterDrop = Invoke-RemotePsql 'CLEANUP_VERIFY_ROLE_AFTER' "SELECT count(*) FROM pg_roles WHERE rolname = $(ConvertTo-SqlLiteral $cloneRole);" 'postgres'
        if ($roleAfterDrop.ExitCode -ne 0 -and -not $cloneDropSucceeded) { $remaining += 'role verification failed' }
        elseif (-not $cloneDropSucceeded -and $roleAfterDrop.Stdout.Trim() -ne '0') { $remaining += "role remains: $cloneRole" }
    } catch { if (-not $cloneDropSucceeded) { $remaining += 'role verification failed' } }
    $report.cleanup.leftovers = @($remaining | Select-Object -Unique)
    if ($report.cleanup.leftovers.Count -eq 0) {
        $report.clone.cleaned = $true
        $report.cleanup.status = 'COMPLETE'
    } else {
        $report.cleanup.status = 'INCOMPLETE'
    }
    if ($report.cleanup.leftovers.Count -gt 0) { $report.cleanup.status = 'INCOMPLETE' }
    if ($report.verdict -ne 'READY_FOR_DEPLOYMENT_CANDIDATE' -and -not $report.exitCode) {
        if ($report.gui.status -eq 'INFRA_DEPENDENCY_MISSING') { $report.exitCode = 10 }
        elseif ($report.gui.rdpProfileProof -ne 'PASS') { $report.exitCode = 30 }
        elseif ($report.cleanup.status -eq 'INCOMPLETE') { $report.exitCode = 40 }
        else { $report.exitCode = 20 }
    }
    New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $reportRoot 'report.json') -Encoding UTF8
    $syntheticStatus = if ($report.syntheticE2E.PSObject.Properties.Name -contains 'status') { $report.syntheticE2E.status } elseif ($report.syntheticE2E.pass -eq $true) { 'PASS' } else { 'NOT_READY' }
    @("# FNS self-service final E2E", "", "- Timestamp: $($report.timestamp)", "- Verdict: $($report.verdict)", "- GUI: $($report.gui.status)", "- RDP/profile proof: $($report.gui.rdpProfileProof)", "- Synthetic E2E: $syntheticStatus", "- Cleanup: $($report.cleanup.status)", "- Production mutated: $($report.production.mutated)") | Set-Content -LiteralPath (Join-Path $reportRoot 'report.md') -Encoding UTF8
}

Write-Output "FNS self-service E2E report: $(Join-Path $reportRoot 'report.json')"
Write-Output "Verdict: $($report.verdict)"
if ($report.verdict -ne 'READY_FOR_DEPLOYMENT_CANDIDATE') { if ($report.exitCode) { exit ([int]$report.exitCode) } else { exit 20 } }
exit 0
