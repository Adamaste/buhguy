# Matched-Purchase Writer Orchestration Preview v1

`matched-purchase-writer-orchestration-v1` is a read-only operational preview
over the authoritative `bank-receipt-matching-v1` and
`matched-purchase-enrichment-projection-v1` layers. It never invokes
`persistMatchedPurchase`, writes to the database, or wires execution into sync
or accounting catch-up.

The preview requires explicit finite positive internal-transfer and receipt
matching windows. It loads the authoritative matching result, evaluates each
`MATCHED` pair through the enrichment projection, and emits deterministic safe
structured decisions keyed by stable semantic identifiers. The result exposes
scope, match/enrichment keys, source ids, exact amount/currency/times, account
identity, purchase and ledger dispositions, safe reason codes, and a stable
orchestration key. Raw notification/receipt payloads, secrets, and unnecessary
ownership details are never emitted.

## Decisions

- `PERSIST_REQUIRED`: enrichment is `PROJECTED` with either
  `REFINE_EXISTING_FISCAL_FUNDING` or
  `FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED`.
- `NOOP_ALREADY_PERSISTED`: enrichment is `PROJECTED` with valid current
  `REUSE_EXISTING_BANK_FUNDING` provenance; the plan expects no semantic
  change.
- `BLOCKED`: a matched pair exists but enrichment is blocked or conflicting.

Matcher-level `AMBIGUOUS`, `UNMATCHED`, and `INELIGIBLE` rows remain visible
with safe identifiers and reason codes. Ordinary unmatched/ineligible evidence
does not make the whole preview fail. Any ambiguity or blocked matched pair
makes readiness `REVIEW_REQUIRED`; otherwise readiness is `READY`.

Each matched decision includes a deterministic future write plan:

- bank receipt match: `CREATE_OR_REUSE`;
- purchase: `CREATE_OR_REUSE` or `REUSE`;
- bank evidence: `CREATE_OR_REUSE`;
- financial-account ledger mapping: `CREATE_OR_REUSE`;
- bank-funded ledger entry: `CREATE_OR_REUSE`;
- supersession: `APPEND_OR_REUSE` only for refinement;
- certification: `REFRESH_ACTIVE_STATE`.

The no-op plan uses `REUSE` for persisted semantic rows and sets
`expectedSemanticChange=false`.

## Future execution policy

The future executor must consume only `PERSIST_REQUIRED` decisions and invoke
the public authoritative writer one `matchKey` at a time, with one writer
transaction per match. It must skip `NOOP_ALREADY_PERSISTED` and never invoke
`BLOCKED` or `AMBIGUOUS`. An unrelated ambiguous matching component must not
change an isolated proven decision. Transient infrastructure/database failures
may be retried externally; semantic conflicts and ambiguity must not be
blindly retried until source state changes. The writer remains the final
authoritative revalidation boundary.

The CLI is read-only:

```text
receipt-collector matched-purchase preview \
  --scope-key <scope> \
  --internal-transfer-window-ms <ms> \
  --receipt-window-ms <ms> \
  [--from <iso>] [--to <iso>] [--match-key <sha256>]
```

Mutation flags and subcommands are rejected. Exit code `0` means `READY`, exit
code `2` means `REVIEW_REQUIRED`, and invalid input/database failures retain
normal operational error handling.
