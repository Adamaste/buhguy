# FNS Receipt Currency Contract v1

`fns-receipt-currency-v1` is the reviewed source-derived currency contract for
FNS fiscal receipts.

FNS fiscal-document semantics define `totalSum`, `cashTotalSum`, and
`ecashTotalSum` in Russian rubles. When an immutable receipt has proven source
membership through `receipt_source_observations -> fns_sources` and no explicit
currency is present, the resolver returns `RESOLVED / RUB` with basis
`FNS_SOURCE_CONTRACT`. This is source-derived evidence, not a matcher
heuristic and not a mutation of the canonical `receipts.currency` column.

An explicit valid `RUB` value is preserved as explicit payload evidence.
Explicit non-RUB and malformed currency values fail closed as `CONFLICT`.
Missing currency without proven FNS source membership is `UNRESOLVED`.

The resolver returns a safe structured result containing status, currency,
model version, basis, reason code, and source family. The derivation result is
included in receipt-candidate and match semantic identity, so replay cannot
silently treat a different currency-evidence basis as the same candidate.

No foreign-exchange inference exists. Raw evidence and canonical receipt rows
remain unchanged; no normalization rebuild, replay, backfill, migration, or
production execution is part of this contract.
