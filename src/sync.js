import { normalizeReceiptDetail } from './normalize.js';
import { SessionExpiredError } from './errors.js';
import { isKnownFnsDetailUnavailable, safeDetailErrorFields } from './fns-detail-errors.js';

export async function syncReceipts({ client, repository, normalizer = null, matcher = null, returnMatcher = null, standaloneMatcher = null, ledgerRefresher = null, certificationRefresher = null, detailErrorClassifier = isKnownFnsDetailUnavailable, accountKey = 'default', sourceContext = null, pageSize = 50, logger = console }) {
  const startedAt = new Date().toISOString();
  await repository.updateSyncState(accountKey, { startedAt, finishedAt: null, error: null });
  if (sourceContext?.sourceId) await repository.updateSourceSyncState(sourceContext.sourceId, { startedAt, fetched: 0, inserted: 0, replayed: 0 });
  const result = { fetched: 0, inserted: 0, alreadyExisted: 0, errors: 0 };
  if (sourceContext?.sourceId && repository.upsertSourceReceiptReference) Object.assign(result, { resolved: 0, detailUnavailable: 0, retryPending: 0, unclassified: 0, unexpectedErrors: 0 });
  if (normalizer) {
    result.source_ingest_success_count = 0;
    result.normalization_ready_count = 0;
    result.normalization_blocked_count = 0;
    result.normalization_unsupported_count = 0;
    result.normalization_failed_count = 0;
    result.matcher_examined = 0;
    result.matcher_confirmed = 0;
    result.matcher_ambiguous = 0;
    result.matcher_candidate_only = 0;
    result.matcher_unmatched = 0;
    result.matcher_failed = 0;
    result.return_matcher_examined = 0;
    result.return_matcher_confirmed = 0;
    result.return_matcher_ambiguous = 0;
    result.return_matcher_candidate_only = 0;
    result.return_matcher_unmatched = 0;
    result.return_matcher_failed = 0;
    result.standalone_purchase_examined = 0;
    result.standalone_purchase_created = 0;
    result.standalone_purchase_failed = 0;
  }
  let offset = 0;
  try {
    while (true) {
      const page = await client.listReceipts({ limit: pageSize, offset, orderBy: 'CREATED_DATE:DESC' });
      result.fetched += page.receipts.length;
      for (const summary of page.receipts) {
        if (sourceContext?.sourceId && repository.upsertSourceReceiptReference) {
          const reference = await repository.upsertSourceReceiptReference({ sourceId: sourceContext.sourceId, sourceReceiptId: summary.id });
          if (reference.status === 'RESOLVED') { result.resolved += 1; continue; }
          if (reference.detail_next_retry_at && new Date(reference.detail_next_retry_at).getTime() > Date.now()) { result.retryPending += 1; continue; }
          await repository.markSourceReceiptDetailAttempt({ sourceId: sourceContext.sourceId, sourceReceiptId: summary.id });
        }
        try {
          const raw = await client.getReceiptRaw(summary.id);
          const saved = sourceContext?.sourceId
            ? await repository.upsertObservedBundle({ sourceId: sourceContext.sourceId, sourceReceiptId: summary.id, normalized: normalizeReceiptDetail(raw, { sourceId: summary.id }), raw, listSummary: summary })
            : await repository.upsertBundle({ normalized: normalizeReceiptDetail(raw, { sourceId: summary.id }), raw, listSummary: summary });
          if (sourceContext?.sourceId && repository.markSourceReceiptResolved) {
            await repository.markSourceReceiptResolved({ sourceId: sourceContext.sourceId, sourceReceiptId: summary.id, receiptId: saved.id });
            result.resolved += 1;
          }
          if (saved?.created === false) { result.alreadyExisted += 1; logger.info?.('fiscal_receipt_replay', { receiptId: summary.id }); }
          else { result.inserted += 1; logger.info?.('fiscal_receipt_inserted', { receiptId: summary.id }); }
          if (normalizer) result.source_ingest_success_count += 1;
          if (normalizer && saved?.id && !(sourceContext?.sourceId && saved.created === false)) {
            try {
              const normalized = await normalizer(saved.id);
              const status = normalized?.facts?.normalizationStatus;
              if (status === 'READY') result.normalization_ready_count += 1;
              else if (status === 'BLOCKED') result.normalization_blocked_count += 1;
              else if (status === 'UNSUPPORTED') result.normalization_unsupported_count += 1;
              if (matcher && status === 'READY') {
                try {
                  const matched = await matcher(saved.id, normalized);
                  const summary = matched?.summary ?? {};
                  result.matcher_examined += Number(summary.settlementsExamined ?? 0);
                  result.matcher_confirmed += Number(summary.confirmedSettlements ?? 0);
                  result.matcher_ambiguous += Number(summary.ambiguousSettlements ?? 0);
                  result.matcher_candidate_only += Number(summary.candidateOnlySettlements ?? 0);
                  result.matcher_unmatched += Number(summary.unmatchedSettlements ?? 0);
                  logger.info?.('prepayment_settlement_reconsidered', { receiptId: summary.receiptId ?? saved.id, status: matched?.triggerStatus ?? 'RECONSIDERED' });
                } catch (matcherError) {
                  result.matcher_failed += 1;
                  logger.error?.('prepayment_settlement_matcher_failure', { receiptId: summary.id, errorCode: 'MATCHER_EXCEPTION', error: matcherError.message });
                }
              }
              // Return reconsideration is bounded to newly ingested return receipts;
              // replaying the full corpus must not rescan every historical return.
              if (returnMatcher && status === 'READY' && Number(normalized?.facts?.fiscalOperationType) === 2 && saved?.created !== false) {
                try {
                  const matched = await returnMatcher(saved.id, normalized);
                  const returnSummary = matched?.summary ?? {};
                  result.return_matcher_examined += Number(returnSummary.returnsExamined ?? 0);
                  result.return_matcher_confirmed += Number(returnSummary.confirmed ?? 0);
                  result.return_matcher_ambiguous += Number(returnSummary.ambiguous ?? 0);
                  result.return_matcher_candidate_only += Number(returnSummary.candidateOnly ?? 0);
                  result.return_matcher_unmatched += Number(returnSummary.unresolved ?? 0);
                  logger.info?.('return_refund_reconsidered', { receiptId: matched?.receiptId ?? saved.id, status: matched?.triggerStatus ?? 'UNRESOLVED' });
                } catch (returnMatcherError) {
                  result.return_matcher_failed += 1;
                  logger.error?.('return_refund_matcher_failure', { receiptId: saved.id, errorCode: 'RETURN_MATCHER_EXCEPTION', error: returnMatcherError.message });
                }
              }
              let standalone = null;
              if (standaloneMatcher && status === 'READY') {
                try {
                  standalone = await standaloneMatcher(saved.id, normalized);
                  result.standalone_purchase_examined += Number(standalone?.examined ?? 1);
                  result.standalone_purchase_created += Number(standalone?.created ?? 0);
                } catch (standaloneError) {
                  result.standalone_purchase_failed += 1;
                  logger.error?.('standalone_purchase_failure', { receiptId: saved.id, errorCode: 'STANDALONE_PURCHASE_EXCEPTION', error: standaloneError.message });
                }
              }
              if (ledgerRefresher && (saved?.created !== false || Number(standalone?.created ?? 0) > 0)) {
                try {
                  const ledger = await ledgerRefresher(saved.id);
                  logger.info?.('ledger_incremental_refresh', { receiptId: saved.id, bounded: ledger?.bounded === true, eventCount: ledger?.eventIds?.length ?? 0, createdEntries: ledger?.created?.entries ?? 0 });
                  if (certificationRefresher && ledger?.eventIds?.length) {
                    try {
                      const certification = await certificationRefresher(ledger.eventIds);
                      logger.info?.('certification_incremental_refresh', { receiptId: saved.id, bounded: certification?.bounded === true, eventCount: certification?.eventIds?.length ?? 0, facts: certification?.facts ?? 0 });
                    } catch (certificationError) {
                      result.certification_refresh_failed = (result.certification_refresh_failed ?? 0) + 1;
                      logger.error?.('certification_incremental_refresh_failure', { receiptId: saved.id, errorCode: 'CERTIFICATION_REFRESH_FAILED', error: certificationError.message });
                    }
                  }
                } catch (ledgerError) {
                  result.ledger_refresh_failed = (result.ledger_refresh_failed ?? 0) + 1;
                  logger.error?.('ledger_incremental_refresh_failure', { receiptId: saved.id, errorCode: 'LEDGER_REFRESH_FAILED', error: ledgerError.message });
                }
              }
            } catch (normalizationError) {
              result.normalization_failed_count += 1;
              logger.error?.('fiscal_normalization_failure', { receiptId: summary.id, errorCode: 'NORMALIZER_EXCEPTION', error: normalizationError.message });
            }
          }
        } catch (error) {
          if (sourceContext?.sourceId && repository.markSourceReceiptDetailUnavailable && detailErrorClassifier(error)) {
            await repository.markSourceReceiptDetailUnavailable({ sourceId: sourceContext.sourceId, sourceReceiptId: summary.id, error: safeDetailErrorFields(error) });
            result.detailUnavailable += 1;
            logger.warn?.('fns_detail_unavailable', { sourceId: sourceContext.sourceId, status: error.status, signature: safeDetailErrorFields(error).errorSignature });
            continue;
          }
          result.errors += 1;
          if (sourceContext?.sourceId && repository.upsertSourceReceiptReference) {
            result.unexpectedErrors += 1;
            result.unclassified += 1;
          }
          if (error.code === 'FISCAL_IDENTITY_CONFLICT') result.fiscalIdentityConflicts = (result.fiscalIdentityConflicts ?? 0) + 1;
          if (error.code === 'FISCAL_CONTENT_CONFLICT') result.fiscalContentConflicts = (result.fiscalContentConflicts ?? 0) + 1;
          if (sourceContext?.sourceId && repository.markSourceReceiptRetryable) await repository.markSourceReceiptRetryable({ sourceId: sourceContext.sourceId, sourceReceiptId: summary.id, error: safeDetailErrorFields(error) });
          logger.error?.('fiscal_ingest_failure', { receiptId: summary.id, errorCode: error.code ?? 'RECEIPT_SYNC_FAILED', error: error.message });
        }
      }
      offset += page.receipts.length;
      if (!page.hasMore || page.receipts.length === 0) break;
    }
    const degraded = result.errors > 0 || result.normalization_blocked_count > 0 || result.normalization_unsupported_count > 0 || result.normalization_failed_count > 0 || result.matcher_failed > 0 || result.return_matcher_failed > 0 || result.standalone_purchase_failed > 0 || result.ledger_refresh_failed > 0 || result.certification_refresh_failed > 0;
    const degradedReason = result.matcher_failed > 0 ? 'matcher incomplete' : 'normalization incomplete';
    await repository.updateSyncState(accountKey, { startedAt, finishedAt: new Date().toISOString(), error: degraded ? degradedReason : null });
    if (sourceContext?.sourceId) await repository.updateSourceSyncState(sourceContext.sourceId, { startedAt, finishedAt: new Date().toISOString(), error: degraded ? degradedReason : null, fetched: result.fetched, inserted: result.inserted, replayed: result.alreadyExisted });
    return result;
  } catch (error) {
    await repository.updateSyncState(accountKey, { startedAt, finishedAt: new Date().toISOString(), error: error.message });
    if (sourceContext?.sourceId) await repository.updateSourceSyncState(sourceContext.sourceId, { startedAt, finishedAt: new Date().toISOString(), error: error.message, errorClass: error.code ?? error.name, fetched: result.fetched, inserted: result.inserted, replayed: result.alreadyExisted });
    if (error instanceof SessionExpiredError) {
      result.errors += 1;
      result.authError = 'FNS authentication/refresh failed';
      logger.error?.('FNS authentication failed during sync', { status: error.status, errorCode: error.code });
      return result;
    }
    throw error;
  }
}
