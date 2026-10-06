# Bank-to-receipt matching v1

`bank-receipt-matching-v1` is a deterministic, fail-closed, non-mutating
evidence matcher. It links a validated bank-backed `PURCHASE` movement with
an independently normalized FNS receipt. The receipt is enrichment evidence;
the bank movement remains the sole cash-flow fact.

## Input chain

The pure matcher accepts bank `{ journal, candidate }` entries, an explicit
account-ownership snapshot, and normalized receipt rows. It first calls the
authoritative `projectBankLedger()` boundary. Caller-supplied ledger objects
are not trusted, and internal-transfer consumption is completed before a
receipt match is considered.

The bank side is eligible only for a projected `PURCHASE` whose balanced
postings are exactly `Dr UNCLASSIFIED_PURCHASE` and `Cr FINANCIAL_ACCOUNT`.
The account must have explicit `OWNER` evidence in the same accounting scope.
This proves bank-account ownership only; it does not prove that the owner was
the receipt payer. Source context, provider/device identity,
`AUTHORIZED_USER`, and `fns_source_person.OBSERVED_BY` are not payer proof.
Transfers, internal transfers, and unclassified movements never match.

## Receipt eligibility

V1 accepts only the strict normalized family:

- `fiscal-normalizer-v1`, `READY`, sale operation, `OUT`, and known currency;
- reconciled `SETTLEMENT_ONLY` payment components;
- non-correction evidence with every normalized item payment type `4`;
- positive `ecash_total_sum` as `PRESENT_VALUE`;
- explicit zero cash, prepaid, credit, and provision components;
- `total_sum` exactly equal to `ecash_total_sum`;
- exactly one accounting scope resolved through
  `receipt_source_observations -> fns_sources -> accounting_scopes`.

Cash-only, mixed payment, prepayment, advance, credit, return/refund,
correction, missing/unknown currency, and incomplete or inconsistent fiscal
evidence are ineligible. The match amount is the exact canonical
`ecash_total_sum`; `total_sum` is only a consistency check. No tolerance,
rounding, floating-point conversion, or currency conversion is used.

## Matching rules

Compatibility requires the same scope, exact amount and currency, and an
absolute event-time difference within the explicit inclusive bounded
`receiptMaxTimeDeltaMs` window. Receipt time may be before or after the bank
event. Merchant, seller, and nearest-time selection are not used.

The matcher builds the complete bipartite graph. An isolated component with
exactly one bank and one receipt node becomes `MATCHED`; zero-edge eligible
nodes are `UNMATCHED`; every larger or multiply connected component is
`AMBIGUOUS`. There is no greedy matching, first-id selection, or candidate
reuse. Match and receipt candidate keys are content-addressed and include the
normalized fiscal fingerprint and ownership provenance.

## Persistence boundary

The output contains only evidence relationships and statuses. It emits no
postings, ledger entry, business event, receipt relationship row, migration,
or reconciliation mutation. Existing `STANDALONE_PURCHASE_V1` receipt-only
events remain unchanged. Any future persistence must enrich or link the
existing economic purchase representation rather than create a second cash
flow, ledger entry, or silently rewrite history.

The optional loader performs SELECT-only reads: bank journals are loaded once,
bank candidates and ledger projection are derived in memory, ownership is
loaded once for concrete accounts, and normalized receipt facts and resolved
receipt scopes are loaded without joining `fns_source_person`.
