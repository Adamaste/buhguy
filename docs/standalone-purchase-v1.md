# STANDALONE_PURCHASE_V1

## Scope

This phase adds a read-only census and bounded persistence path for ordinary one-stage purchases. Production deployment is intentionally not included.

Eligibility requires normalized `READY` evidence, operation type `1`, fiscal operation type `1`, `SETTLEMENT_ONLY`, reconciled payment components, explicit zero prepaid/credit/provision components, and cash plus electronic cash equal to the fiscal total. A missing currency is accepted because the current corpus stores currency as `NULL` and the existing ledger semantics treat that as default `RUB`; known non-`RUB` currencies fail closed.

Receipts already covered by a confirmed `PREPAYMENT_FOR`/`FULFILLS` lifecycle or confirmed purchase evidence are excluded. This prevents the Xiaomi prepayment plus settlement lifecycle from creating a second purchase.

## Runtime

- Rule: `STANDALONE_PURCHASE_V1`
- Version: `standalone-purchase-v1`
- Semantic key: `standalone-purchase:<receipt_id>`
- Origin: `SYSTEM_DERIVED`
- Evidence: exact normalized receipt evidence
- Ledger rule: `LEDGER_STANDALONE_PURCHASE_V1`
- Replays use a bounded receipt-scoped ledger/certification refresh.

## Verification

Read-only production census on the current 1703-receipt snapshot:

- Eligible: `1119`, fiscal amount `992905.44` RUB
- Existing confirmed multi-receipt lifecycle: `76`, `196084.00` RUB
- Existing purchase evidence: `7`, `2816.29` RUB
- Prepayment: `102`, `311507.05` RUB
- Advance: `5`, `6026.60` RUB
- Mixed: `1`, `3880.00` RUB
- Prepaid component: `107`, `162440.56` RUB
- Other unsupported: `286`, `90450.35` RUB

August 2026 (`[2026-08-01T00:00:00+03, 2026-09-01T00:00:00+03)`):

- Type-1 receipts: `83`, `286187.53` RUB
- Eligible standalone: `35`, `157433.52` RUB
- Existing lifecycle: `8`, `80262.00` RUB
- Other excluded: `48`, `128754.01` RUB

Disposable clone from backup:

- Source counts stayed `1703 / 5792 / 1703`; normalized counts stayed `1703 / 5792`.
- First persist: `1119` created.
- Bounded propagation: `1119` ledger entries, `2414` ledger postings, `3355` certification facts.
- Second persist: `0` created, `1119` reused.
- Graph validator: PASS.
- Ledger balance violations: `0`.
- RETURN edges: unchanged (`8`).
- Duplicate purchase semantic keys: `0`.
- Clone certification acquisition: `1093629.73` RUB; fiscal new money: `1093629.73` RUB provisional.
- Clone August certified acquisition: `39` receipts, `197564.52` RUB; fiscal new money is also provisional.

The existing Xiaomi IDs `62` (prepayment) and `54` (fulfillment) remain represented by one confirmed purchase lifecycle of `32380.00` RUB through graph edges; neither receipt is eligible for standalone creation. The existing 8 RETURN edges remained valid.

## Known Independent Limitation

The previously recorded destructive full ledger rebuild conflicts with existing certification foreign keys. This phase does not change that behavior; validation uses the bounded incremental path and local ledger regression coverage instead.
# Historical audit snapshot

The census below is retained as historical validation evidence and is not a current production contract.
