# Bank Internal Transfer Matching v1

`bank-internal-transfer-matching-v1` is a deterministic, non-mutating projection
for recognizing one own-account transfer from two independently proven bank
sides. It runs in memory and does not persist a business event, journal, ledger
entry, reconciliation result, receipt relationship, or account-resolution fact.

## Input and coherence

The matcher consumes `{ candidate, journal }` pairs from the existing chain:

`bank transaction -> bank-cash-flow-projection-v1 -> balanced-bank-journal-projection-v1 -> bank-business-event-candidate-projection-v1`

Each candidate is regenerated from its journal with the official projection.
The supplied candidate must exactly match the regenerated contract, including
the candidate key, journal key, transaction identity, scope, amount, currency,
semantics, bank side, and safe source provenance. Tampered or missing pairs are
ineligible. Duplicate candidate keys, journal keys, or transaction ids are
rejected rather than silently deduplicated.

## Eligibility and ownership

Only projected `TRANSFER` candidates with `OUTGOING` or `INCOMING` direction
and a concrete positive financial-account bank side are eligible. Unresolved
bank sides, purchase candidates, unknown semantics, and incomplete monetary
evidence remain ineligible.

Both accounts must be in the same candidate scope, and each account must have
explicit `OWNER` evidence for the same accounting person and scope. Only
non-empty ownership provenance is accepted. `AUTHORIZED_USER`, source-context
identity, provider/device identity, and payment-instrument identity are not
ownership evidence. One-sided transfers and transfers involving different
people never become `INTERNAL_TRANSFER`.

## Matching policy

An outgoing and incoming candidate match only when they have distinct
transactions, candidate/journal keys, and financial accounts; exact equal
amount and currency strings; compatible scope; exactly one common owner; and
an absolute `occurredAt`/event-time delta within the caller-supplied finite positive safe
integer `maxTimeDeltaMs` window. The window is inclusive and is evaluated
without money arithmetic.

All compatible edges are built before selecting matches. A connected component
is matchable only when it contains exactly one outgoing node, one incoming node,
and one edge. Zero-edge candidates are `UNMATCHED`; larger or multi-edge
components are `AMBIGUOUS`. There is no greedy, nearest, first-match, fan-out,
or candidate reuse behavior.

## Output and determinism

The projection returns `MATCHED`, `UNMATCHED`, `AMBIGUOUS`, and `INELIGIBLE`
candidate statuses plus matched pairs and summary counters. A match is a
directional `INTERNAL_TRANSFER` candidate with both source candidate/journal/
transaction identities, account ids, exact amount/currency, bounded time
delta, and safe ownership provenance. Its content-addressed match key covers
the model/policy, scope, amount/currency, owner, both sides, and canonical
ownership evidence, so identical inputs are stable while material changes are
different.

Unmatched one-sided transfer candidates remain unchanged. No expense, income,
merchant, counterparty, purchase, receipt match, or other business meaning is
inferred. The output is not written to existing receipt-oriented business-event
tables, ledger tables, or reconciliation state.

## Read-only production convenience loader

The optional loader invokes the existing balanced-journal loader once, projects
business-event candidates once, verifies candidate-to-journal transaction and
journal-key coherence, and performs one `SELECT`-only ownership snapshot from
financial accounts, accounting scopes, persons, and explicit `OWNER` relations.
It does not read source ownership context as account ownership evidence and
does not perform writes, migrations, replay, backfill, or deployment.
