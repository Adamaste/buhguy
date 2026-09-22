import { SessionStore } from './session-store.js';
import { loadFnsSourceConfig } from './fns-source-config.js';

export async function resolveSyncSources({ configFile = process.env.FNS_SOURCES_CONFIG, legacySessionStore = new SessionStore(), legacySourceKey = 'legacy-default' } = {}) {
  const configured = await loadFnsSourceConfig(configFile);
  if (configured) return { explicit: true, sources: configured };
  return {
    explicit: false,
    sources: [{
      enabled: true,
      scopeKey: 'default',
      sourceKey: legacySourceKey,
      displayName: 'Legacy FNS source',
      personKey: 'legacy-current-user',
      personDisplayName: 'Legacy current user',
      sessionDir: legacySessionStore.stateDir,
      sessionRef: `filesystem:${legacySessionStore.stateDir}/session.json`,
      deviceRef: `filesystem:${legacySessionStore.stateDir}/device.json`,
    }],
  };
}

export function effectiveAccountingScopeKey(source, scopeOverride = null) {
  return source?.scopeKey ?? scopeOverride ?? 'default';
}

export function deriveAccountingCatchupScopeKeys(sources, scopeOverride = null) {
  const scopes = new Set();
  for (const source of sources ?? []) {
    if (source.enabled === false) continue;
    scopes.add(effectiveAccountingScopeKey(source, scopeOverride));
  }
  return [...scopes];
}

export async function runAccountingCatchupsForSources(sources, scopeOverride, runCatchup) {
  for (const scopeKey of deriveAccountingCatchupScopeKeys(sources, scopeOverride)) await runCatchup(scopeKey);
}

function hasFailedResult(result) {
  return Boolean(
    result?.errors
      || result?.unclassified
      || result?.authError
      || result?.normalization_failed_count
      || result?.normalization_blocked_count
      || result?.normalization_unsupported_count
      || result?.matcher_failed
      || result?.return_matcher_failed
      || result?.standalone_purchase_failed
      || result?.ledger_refresh_failed
      || result?.certification_refresh_failed,
  );
}

export async function runSourceSyncCycle({ repository, runSource, logger = console, ...resolveOptions }) {
  const { explicit, sources } = await resolveSyncSources(resolveOptions);
  const results = [];
  for (const source of sources) {
    if (source.enabled === false) {
      results.push({ sourceKey: source.sourceKey, scopeKey: source.scopeKey ?? 'default', enabled: false, attempted: false, result: null });
      continue;
    }
    const startedAt = Date.now();
    let sourceRow = null;
    try {
      sourceRow = await repository.ensureSource(source);
      logger.info?.('source_sync_started', { sourceId: sourceRow.id, sourceKey: source.sourceKey });
      const result = await runSource({ source, sourceRow, explicit });
      const failed = hasFailedResult(result);
      results.push({ sourceId: sourceRow.id, sourceKey: source.sourceKey, scopeKey: source.scopeKey ?? 'default', enabled: true, attempted: true, failed, result });
      logger[failed ? 'error' : 'info']?.('source_sync_finished', {
        sourceId: sourceRow.id,
        sourceKey: source.sourceKey,
        fetched: result?.fetched ?? 0,
        inserted: result?.inserted ?? 0,
        alreadyExisted: result?.alreadyExisted ?? 0,
        errors: result?.errors ?? 0,
        resolved: result?.resolved ?? 0,
        detailUnavailable: result?.detailUnavailable ?? 0,
        retryPending: result?.retryPending ?? 0,
        unclassified: result?.unclassified ?? 0,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const safeResult = { fetched: 0, inserted: 0, alreadyExisted: 0, errors: 1, error: error.message, errorClass: error.code ?? error.name };
      if (sourceRow?.id) {
        await repository.updateSourceSyncState(sourceRow.id, { startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), error: error.message, errorClass: error.code ?? error.name });
      }
      results.push({ sourceId: sourceRow?.id ?? null, sourceKey: source.sourceKey, scopeKey: source.scopeKey ?? 'default', enabled: true, attempted: true, failed: true, result: safeResult });
      logger.error?.('source_sync_failed', { sourceId: sourceRow?.id ?? null, sourceKey: source.sourceKey, errorCode: error.code ?? 'SOURCE_SYNC_FAILED', error: error.message, durationMs: Date.now() - startedAt });
    }
  }
  const attempted = results.filter((item) => item.attempted);
  const failed = attempted.filter((item) => item.failed);
  return { explicit, sources: results, attempted: attempted.length, failed: failed.length, exitCode: failed.length ? 2 : 0 };
}
