# Accounting-Grade Audit v3

## Verdict

**BLOCKED for certified accounting analytics; PROVISIONAL for evidence collection.** This audit was read-only. No production schema, data, FNS session, timer or analytics behavior was changed.

## Facts from production

The sanitized aggregate is in `artifacts/accounting-audit/corpus-summary.json`. It records 1691 receipts, 5762 items and 1691 raw payloads over 2024-06-18 through 2026-09-05. Operation types are 1: 1407, 2: 283, 3: 1, 4: 0; all normalized values match raw and satisfy the constraint. FFD versions are 2: 51, 3: 1 and 4: 1639.

All five payment components are present in this corpus and sum exactly to total at two decimals for all 1691 receipts. Nevertheless, fiscal positive total is 1669072.06 RUB while positive new cash/e-cash is 1413134.50 RUB; the 255937.56 RUB gap is lifecycle exposure, not certified spend.

Payment type is item-scoped: observed item values are 1: 441, 3: 6 and 4: 5315. One receipt is mixed. Therefore a receipt-level payment lifecycle state is not safe.

## Xiaomi evidence

The two 32380 RUB events dated 2026-08-19 and 2026-08-22 match the known case. The first has 32380 in electronic cash; the second has 32380 prepaid and zero new cash/e-cash. This is consistent with one purchase lifecycle and two fiscal events. It must not be generalized from amount/date alone.

## Answers to the required questions

1. The architecture can become accounting-grade, but the current POC is not there.
2. Silent errors arise from treating receipt totals as spend, pairing by amount/time, deriving lifecycle from operation/payment type, and converting missing fields to zero.
3. Deterministic eliminations are raw hashing, scoped external IDs, explicit event graph, bounded allocations, append-only interpretations, double-entry invariants and full-rebuild replay.
4. Inherent ambiguities include repeated purchases, settlement without order evidence, partial returns, cancellations, stored value, credits, corrections and missing FFD-specific fields.
5. Additional useful sources are merchant/order/payment IDs, fulfillment/delivery, marketplace APIs, bank/card transactions, returns/refunds and user ownership metadata. Email is optional evidence, not a required foundation.
6. Double-entry is appropriate once the event graph exists; use cash/e-cash, advance, expense/asset, refund, credit and suspense accounts with explicit postings.
7. Source-of-truth is immutable raw evidence first, then versioned parsing, event graph, ledger, and certified analytics.
8. CERTIFIED requires fresh complete evidence, balanced ledger, reconciled components, no material unresolved exceptions, explicit policy/rule versions, and successful rebuild.
9. Biggest current risk is false financial certainty from double-counting advance and settlement.
10. First implementation should be evidence metadata plus an event graph and reconciliation/exception queue, before categories or broad automation.
11. The current operation type backfill is useful normalization but does not solve payment lifecycle.
12. The old August figure 273007.27 RUB is not authoritative until rebuilt from cash/advance allocations.
13. The safe current status is BLOCKED for accounting certification, with receipt ingestion PROVISIONAL.

## Required production implementation after review

Introduce append-only evidence metadata, parser versions/content hashes, payment components, lifecycle events, allocation records, reconciliation exceptions, ledger postings, scoped merchant identifiers, and deterministic replay. Start with candidate rules and require the regression matrix before promoting any matching rule to AUTO.

## Safety note

The reports intentionally omit receipt IDs, buyer contacts, seller tax IDs, raw payloads, tokens, passwords and private keys. Production was not modified during this audit.
