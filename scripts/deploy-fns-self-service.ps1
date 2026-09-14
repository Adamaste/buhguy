[CmdletBinding()]
param(
    [string]$KeyPath = $env:FINANCE_VPS_SSH_KEY,
    [string]$HostName = $env:FINANCE_VPS_HOST,
    [string]$RemoteProject = '/opt/accountant/receipt-collector'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($KeyPath) -or [string]::IsNullOrWhiteSpace($HostName)) { throw 'FINANCE_VPS_HOST and FINANCE_VPS_SSH_KEY are required' }
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SshTarget = "root@$HostName"
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$LocalStage = Join-Path $ProjectRoot ".codex-deploy-staging-$Timestamp"
$RemoteStage = "/tmp/fns-self-service-deploy-$Timestamp"
$RemoteScript = Join-Path $LocalStage 'deploy.sh'
$Candidates = [ordered]@{
    'src/fns-user-onboarding.js' = '2FF4DC06BD7020FEF0581910771677408CE1675E050E8E180C9785C95B4B2B6F'
    'src/browser-session-import.js' = 'EC2D3551CF72A4ED8A1D31BD43EEF0C37C5F56816118A6B581648ABFE8210DED'
    'src/onboarding-browser.js' = '2882E3B89045AED451853341F3240F902D6997E5FA05037E56B1E967A7D2E4A8'
    'src/cli.js' = 'E030C6453B65A9E2CF944428F3ACCE046FB62715892AD3A6B3AC8C0094206860'
    'src/fns-source-config.js' = 'EBD53F8875492480A38D40A66C4BE1994A130CA5B802A2ADBCC50ECC1BBA330F'
    'src/source-sync-cycle.js' = 'C1BA4DF9FA23EFC98C0C0C6F3D1A05CFA34620FF2E26EC3FC9ED18ECF93994D8'
    'bin/receipt-collector.js' = '6F3480788506FCB4B571AD5F9C49CF939AD345BB9DB345D268045FBEB449B52A'
}

function Invoke-Native([string]$FilePath, [string[]]$ArgumentList) {
    $out = Join-Path $LocalStage ([guid]::NewGuid().ToString() + '.out')
    $err = Join-Path $LocalStage ([guid]::NewGuid().ToString() + '.err')
    try {
        $p = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $ProjectRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        [pscustomobject]@{ ExitCode = $p.ExitCode; Stdout = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue); Stderr = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
    } finally { Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue }
}

function Get-SafeDiagnostic([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    return (($Text -replace '(?i)(password|token|secret|cookie|authorization)[^\r\n]*','[redacted]') -replace '\s+',' ').Trim()
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH key was not found: $KeyPath" }
New-Item -ItemType Directory -Path $LocalStage -Force | Out-Null

try {
    foreach ($relative in $Candidates.Keys) {
        $local = Join-Path $ProjectRoot ($relative -replace '/', '\')
        if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { throw "Candidate runtime file is missing: $relative" }
        $actual = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($actual -ne $Candidates[$relative]) { throw "Candidate SHA-256 mismatch: $relative" }
    }

    $remotePayload = @'
#!/bin/sh
set -eu
project='__PROJECT__'
stage='__STAGE__'
backup="$project/.deploy-backups/self-service-__TIMESTAMP__"
expected_sources=2
rollback_needed=0
created_files=''
fail() { echo "DEPLOYMENT_FAILED: $1" >&2; exit 1; }
sql_scalar() { sudo -n -u postgres psql -d finance_receipt_collector -Atqc "$1"; }
verify_sources() {
  count="$(sql_scalar "SELECT count(*) FROM public.fns_sources WHERE enabled;")" || fail 'source count query failed'
  [ "$(printf '%s' "$count" | tr -d '[:space:]')" = "$expected_sources" ] || fail 'expected exactly two enabled FNS sources'
  synthetic="$(sql_scalar "SELECT count(*) FROM public.fns_sources WHERE source_key LIKE 'clone-%' OR source_key LIKE 'synthetic-%' OR source_key LIKE 'test-%';")" || fail 'synthetic source query failed'
  [ "$(printf '%s' "$synthetic" | tr -d '[:space:]')" = '0' ] || fail 'synthetic source exists'
  states="$(sql_scalar "SELECT count(*) FROM public.fns_sources s JOIN public.fns_source_sync_state st ON st.fns_source_id=s.id WHERE s.enabled AND st.last_sync_finished_at IS NOT NULL AND st.last_error IS NULL;")" || fail 'source health query failed'
  [ "$(printf '%s' "$states" | tr -d '[:space:]')" = "$expected_sources" ] || fail 'both enabled sources are not healthy'
}
verify_post_sync() {
  states="$(sql_scalar "SELECT count(*) FROM public.fns_sources s JOIN public.fns_source_sync_state st ON st.fns_source_id=s.id WHERE s.enabled AND st.last_sync_finished_at > st.last_sync_started_at AND st.last_error IS NULL AND coalesce(st.last_error_class,'')='';")" || fail 'post-sync source health query failed'
  [ "$(printf '%s' "$states" | tr -d '[:space:]')" = "$expected_sources" ] || fail 'source sync did not succeed for both sources'
  verify_sources
}
rollback() {
  [ "$rollback_needed" -eq 1 ] || return 0
  for rel in src/fns-user-onboarding.js src/browser-session-import.js src/onboarding-browser.js src/cli.js src/fns-source-config.js src/source-sync-cycle.js bin/receipt-collector.js; do
    case " $created_files " in
      *" $rel "*) rm -f "$project/$rel"; continue ;;
    esac
    if [ -f "$backup/$rel" ]; then
      mkdir -p "$project/.deploy-staging/rollback/$(dirname "$rel")"
      cp -p "$backup/$rel" "$project/.deploy-staging/rollback/$rel"
      mv -f "$project/.deploy-staging/rollback/$rel" "$project/$rel"
    fi
  done
  rm -rf "$project/.deploy-staging/rollback" "$stage"
  echo 'RUNTIME_ROLLBACK=COMPLETE' >&2
}
trap rollback EXIT
[ "$(sql_scalar "SELECT current_database();" | tr -d '[:space:]')" = 'finance_receipt_collector' ] || fail 'database identity mismatch'
verify_sources
cd "$project"
mkdir -p "$backup"
for rel in src/fns-user-onboarding.js src/browser-session-import.js src/onboarding-browser.js src/cli.js src/fns-source-config.js src/source-sync-cycle.js bin/receipt-collector.js; do
  if [ -f "$project/$rel" ]; then
    mkdir -p "$backup/$(dirname "$rel")"
    cp -p "$project/$rel" "$backup/$rel"
  else
    created_files="$created_files $rel"
  fi
done
rollback_needed=1
for rel in src/fns-user-onboarding.js src/browser-session-import.js src/onboarding-browser.js src/cli.js src/fns-source-config.js src/source-sync-cycle.js bin/receipt-collector.js; do
  [ -f "$stage/$rel" ] || fail "staged runtime file missing: $rel"
  mkdir -p "$project/.deploy-staging/active/$(dirname "$rel")"
  cp "$stage/$rel" "$project/.deploy-staging/active/$rel"
  if [ -f "$project/$rel" ]; then
    chown --reference="$project/$rel" "$project/.deploy-staging/active/$rel"
    chmod --reference="$project/$rel" "$project/.deploy-staging/active/$rel"
  else
    chown receiptcollector:receiptcollector "$project/.deploy-staging/active/$rel"
    chmod 0644 "$project/.deploy-staging/active/$rel"
  fi
  mv -f "$project/.deploy-staging/active/$rel" "$project/$rel"
done
for rel in src/fns-user-onboarding.js src/browser-session-import.js src/onboarding-browser.js src/cli.js src/fns-source-config.js src/source-sync-cycle.js bin/receipt-collector.js; do
  /usr/bin/node --check "$rel" || fail "node syntax failed: $rel"
done
/usr/bin/node --input-type=module -e "await import('./src/fns-user-onboarding.js'); await import('./src/browser-session-import.js'); await import('./src/onboarding-browser.js'); await import('./src/fns-source-config.js'); await import('./src/source-sync-cycle.js');" || fail 'module load smoke check failed'
/usr/bin/node bin/receipt-collector.js fns-user status >/dev/null || fail 'self-service status smoke check failed'
systemctl start --wait receipt-collector-sync.service || fail 'sync service failed'
result="$(systemctl show receipt-collector-sync.service -p Result --value -p ExecMainStatus --value | tr '\n' ' ')"
case "$result" in success\ 0\ *) : ;; *) fail 'sync service was not success/0' ;; esac
verify_post_sync
/usr/bin/node bin/receipt-collector.js fns-user status >/dev/null || fail 'self-service status post-sync failed'
old_profile='/home/fnslogin/chrome-profile'
if pgrep -af -- "--user-data-dir=$old_profile" >/dev/null 2>&1; then
  fail 'legacy Chromium profile is still in use'
fi
rm -rf -- "$old_profile"
[ ! -e "$old_profile" ] || fail 'legacy Chromium profile was not removed'
rm -rf "$project/.deploy-staging/active" "$stage"
rollback_needed=0
echo 'DEPLOYMENT_SUCCESS=1'
echo "RUNTIME_BACKUP=$backup"
echo 'SOURCE_COUNT=2'
echo 'SYNTHETIC_SOURCE_COUNT=0'
echo 'SYNC_RESULT=success'
'@
    $remotePayload = $remotePayload.Replace('__PROJECT__', $RemoteProject).Replace('__STAGE__', $RemoteStage).Replace('__TIMESTAMP__', $Timestamp)
    Set-Content -LiteralPath $RemoteScript -Value $remotePayload -Encoding ASCII -NoNewline

    $remotePrep = "mkdir -p '$RemoteStage' '$RemoteStage/src' '$RemoteStage/bin' && chmod 700 '$RemoteStage'"
    $prep = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$SshTarget,$remotePrep)
    if ($prep.ExitCode -ne 0) { throw 'Could not prepare remote staging directory' }
    foreach ($relative in $Candidates.Keys) {
        $local = Join-Path $ProjectRoot ($relative -replace '/', '\')
        $copy = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$local,"$SshTarget`:$RemoteStage/$relative")
        if ($copy.ExitCode -ne 0) { throw "Could not upload candidate: $relative" }
    }
    $copyScript = Invoke-Native 'scp.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$RemoteScript,"$SshTarget`:$RemoteStage/deploy.sh")
    if ($copyScript.ExitCode -ne 0) { throw 'Could not upload deployment script' }
    $run = Invoke-Native 'ssh.exe' @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',$KeyPath,$SshTarget,"chmod 700 '$RemoteStage/deploy.sh' && '$RemoteStage/deploy.sh'")
    if ($run.Stdout) { $run.Stdout | Write-Output }
    if ($run.ExitCode -ne 0) {
        $diagnostic = Get-SafeDiagnostic $run.Stderr
        if ([string]::IsNullOrWhiteSpace($diagnostic)) { $diagnostic = Get-SafeDiagnostic $run.Stdout }
        if ([string]::IsNullOrWhiteSpace($diagnostic)) { $diagnostic = 'no remote diagnostic output' }
        throw "FNS self-service deployment failed; remote runtime rollback was attempted: $diagnostic"
    }
} finally {
    Remove-Item -LiteralPath $LocalStage -Recurse -Force -ErrorAction SilentlyContinue
}
