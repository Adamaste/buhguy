# Matched Purchase Persistence Contract v1

Status: design only. This document defines a future persistence boundary for
`matched-purchase-enrichment-projection-v1`; it is not a migration, runtime
implementation, or production write authorization.

## Current foundation and scope

The current in-memory chain is:

`bank transaction`
-> `bank-cash-flow-projection-v1`
-> `balanced-bank-journal-projection-v1`
-> `bank-business-event-candidate-projection-v1`
-> `bank-ledger-projection-v1`
-> `bank-receipt-matching-v1`
-> `matched-purchase-enrichment-projection-v1`.

The authoritative bank movement is the sole monetary funding fact. A matched
receipt adds purchase/acquisition evidence and fiscal detail; it never creates
a second cash flow. The existing `STANDALONE_PURCHASE_V1` purchase identity is
reused conceptually where compatible.

The proposed persistence boundary must remain fail-closed for ambiguous,
contradictory, stale, or incomplete projections. It must not infer payer,
purchase owner, merchant, counterparty, income, expense, or
`INTERNAL_TRANSFER` from account ownership or source context.

## Proposed persisted bank-receipt match

Persist one immutable derived relationship in a dedicated
`bank_receipt_matches` table. It is content-addressed by the reviewed matcher
identity and stores provenance sufficient to revalidate the relationship
without retaining raw notification payloads.

Required facts are:

- accounting scope;
- exact `bank_transaction_id`, `receipt_id`, and resolved
  `financial_account_id`;
- `bank_receipt_matching_version`, `match_key`, and relationship/reason;
- bank ledger, candidate, and journal keys;
- receipt candidate key, normalization version, and normalized content hash;
- exact canonical amount and currency;
- bank `occurred_at` and receipt `date_time`, plus the signed time delta;
- safe bank-account ownership provenance, without payer inference;
- `created_at`.

The match key is a SHA-256 content address over the canonical scope,
relationship, matcher version, source keys, ids, amount/currency, and both
timestamps. Replaying the same authoritative match reuses the same row. A
different semantic identity or disagreement with an existing row fails closed;
it does not update the old row.

Illustrative DDL sketch, not a migration:

```sql
CREATE TABLE bank_receipt_matches (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  bank_transaction_id BIGINT NOT NULL UNIQUE REFERENCES bank_transactions(id),
  receipt_id BIGINT NOT NULL REFERENCES receipts(id),
  financial_account_id BIGINT NOT NULL,
  matcher_version TEXT NOT NULL,
  match_key CHAR(64) NOT NULL UNIQUE,
  bank_ledger_key CHAR(64) NOT NULL,
  bank_candidate_key CHAR(64) NOT NULL,
  bank_journal_key CHAR(64) NOT NULL,
  receipt_candidate_key CHAR(64) NOT NULL,
  receipt_normalization_version TEXT NOT NULL,
  receipt_normalized_content_sha256 CHAR(64) NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  bank_occurred_at TIMESTAMPTZ NOT NULL,
  receipt_date_time TIMESTAMPTZ NOT NULL,
  time_delta_seconds NUMERIC(20,6) NOT NULL,
  relationship_type TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  ownership_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, id),
  FOREIGN KEY (scope_id, financial_account_id)
    REFERENCES financial_accounts(scope_id, id),
  CHECK (currency ~ '^[A-Z]{3}$')
);
```

The production design must also enforce that the bank transaction, receipt
evidence, and financial account are compatible with the selected scope during
the authoritative revalidation step. `ownership_provenance` is structured
provenance, not a payer or beneficiary assertion. No raw payload, source event
text, secret, or account/card reference value is stored by this relationship.

One bank transaction may not be used to create multiple active purchase
matches. A rejected or contradictory replay is retained as a failed decision
outside this immutable match row, or returned without mutation according to the
future operational error contract.

## Separate business-event bank evidence

Do not overload the existing `business_event_evidence`: its current contract is
receipt/item evidence with receipt normalization foreign keys. Add a separate
association, for example `business_event_bank_evidence`, for exactly one active
purchase event and one persisted bank-receipt match.

```sql
CREATE TABLE business_event_bank_evidence (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  business_event_id BIGINT NOT NULL,
  bank_receipt_match_id BIGINT NOT NULL,
  enrichment_key CHAR(64) NOT NULL,
  evidence_role TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  semantic_key CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, bank_receipt_match_id),
  UNIQUE (scope_id, business_event_id, bank_receipt_match_id),
  FOREIGN KEY (scope_id, business_event_id)
    REFERENCES business_events(scope_id, id),
  FOREIGN KEY (scope_id, bank_receipt_match_id)
    REFERENCES bank_receipt_matches(scope_id, id)
);
```

The unique match association prevents one proven match from enriching multiple
active purchases. The future transaction must additionally verify that the
target event is `PURCHASE`, in the same scope, and active. `enrichment_key`,
role, rule version, and semantic key preserve the deterministic projection
provenance.

## Purchase identity and reuse

1. If `STANDALONE_PURCHASE_V1` already created a compatible confirmed
   `PURCHASE`, keep that event and its existing receipt evidence. Add only the
   separate bank evidence association.
2. If no compatible purchase exists, a future transaction may create one
   confirmed `PURCHASE` using the deterministic proposed identity from the
   enrichment projection, then attach both the existing receipt evidence and
   the bank evidence association.
3. If active purchase state is ambiguous, contradictory, cross-scope, stale, or
   otherwise fails revalidation, persist nothing and return a blocked result.

Neither path creates a second purchase for the same economic operation.

## Financial-account to ledger-account mapping

Prefer extending `ledger_accounts` rather than inventing provider-specific
ledger account codes. The future extension should add nullable
`financial_account_id` and nullable `account_currency` to `ledger_accounts`.
Existing unmapped control/receivable rows remain valid with both values null.
For a mapped row:

- `account_type` must be `ASSET`;
- `financial_account_id` and `account_currency` must both be non-null;
- the ledger account and financial account must share `scope_id`;
- `account_currency` must equal `financial_accounts.currency`;
- one financial account may map to at most one ledger account.

The database shape should support this with:

```sql
ALTER TABLE financial_accounts
  ADD CONSTRAINT financial_accounts_scope_id_id_currency_key
  UNIQUE (scope_id, id, currency);

ALTER TABLE ledger_accounts
  ADD COLUMN financial_account_id BIGINT,
  ADD COLUMN account_currency CHAR(3),
  ADD CONSTRAINT ledger_accounts_financial_mapping_shape
    CHECK ((financial_account_id IS NULL AND account_currency IS NULL)
      OR (account_type = 'ASSET'
        AND financial_account_id IS NOT NULL
        AND account_currency IS NOT NULL)),
  ADD CONSTRAINT ledger_accounts_financial_currency_fk
    FOREIGN KEY (scope_id, financial_account_id, account_currency)
    REFERENCES financial_accounts(scope_id, id, currency);

CREATE UNIQUE INDEX ledger_accounts_one_per_financial_account
  ON ledger_accounts(scope_id, financial_account_id)
  WHERE financial_account_id IS NOT NULL;
```

The `financial_accounts` composite uniqueness is needed because PostgreSQL
foreign keys require a referenced unique key matching the full mapped scope,
identity, and currency tuple. Existing financial-account currency remains the
source of truth; provider, source, and OWNER context do not establish payer or
beneficiary semantics.

## Ledger source provenance

Extend `ledger_source_links` minimally with nullable bank provenance while
leaving all current receipt/graph links valid:

```sql
ALTER TABLE ledger_source_links
  ADD COLUMN bank_receipt_match_id BIGINT
    REFERENCES bank_receipt_matches(id),
  ADD COLUMN bank_transaction_id BIGINT
    REFERENCES bank_transactions(id),
  ADD CONSTRAINT ledger_source_links_bank_pair_check
    CHECK (bank_receipt_match_id IS NULL OR bank_transaction_id IS NOT NULL);
```

Future bank-funded replacement entries should have a match link and a direct
bank transaction link as appropriate, with deterministic `link_role` and
`semantic_key`. Existing receipt and graph links remain valid unchanged; the
additive bank-pair check is intentionally conditional on the new columns. The
transaction must reject a link whose source scope, entry scope, and
business-event scope do not agree.

## Append-only ledger supersession

The old standalone fiscal ledger row and postings must never be mutated or
deleted. A dedicated relation records refinement to a bank-funded replacement:

```sql
CREATE TABLE ledger_entry_supersessions (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  superseded_ledger_entry_id BIGINT NOT NULL,
  replacement_ledger_entry_id BIGINT NOT NULL,
  business_event_id BIGINT NOT NULL,
  enrichment_key CHAR(64) NOT NULL,
  reason_code TEXT NOT NULL,
  semantic_key CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, superseded_ledger_entry_id),
  CHECK (superseded_ledger_entry_id <> replacement_ledger_entry_id),
  FOREIGN KEY (scope_id, superseded_ledger_entry_id)
    REFERENCES ledger_entries(scope_id, id),
  FOREIGN KEY (scope_id, replacement_ledger_entry_id)
    REFERENCES ledger_entries(scope_id, id),
  FOREIGN KEY (scope_id, business_event_id)
    REFERENCES business_events(scope_id, id)
);
```

`REFINE_EXISTING_FISCAL_FUNDING` creates one replacement active entry and one
explicit supersession relation, not two active monetary entries. Future chains
may be allowed only under an explicit reviewed policy; the initial transaction
must reject cycles, self-supersession, multiple direct replacements, scope or
business-event disagreement, and replacement ambiguity.

Readers must define an active ledger entry as one with no outgoing
`ledger_entry_supersessions` row. Every ledger, certification, analytics, and
reconciliation reader must apply that predicate and must not count a
superseded `FISCAL_PAYMENT_CLEARING` entry.

## Future replacement entry and certification semantics

The future bank-funded replacement has exactly this monetary shape:

```text
Dr UNCLASSIFIED_ACQUISITION <matched amount>
Cr mapped ledger ASSET account <matched amount>
```

Both postings use the exact matched currency. The monetary timestamp is bank
`occurredAt`; receipt `dateTime` remains independent receipt evidence and is
not substituted for the bank movement time.

- If an exact standalone fiscal entry exists,
  `REFINE_EXISTING_FISCAL_FUNDING` produces one replacement active entry plus
  supersession of the old entry.
- If no ledger entry exists, `FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED` produces one
  active bank-funded entry.
- If either path would leave two active monetary entries, or if the old entry is
  malformed, the operation fails closed.

Certification remains derived from active ledger state. For a matched purchase,
acquisition value exists once, bank funding exists once, the receipt remains
independent acquisition evidence, and no second monetary outflow is counted.
Classification may remain `UNCLASSIFIED` or `PROVISIONAL`; a match does not
prove an expense category, payer, or merchant. Certification facts and
reconciliation results must reference the active replacement entry and a
deterministic source-state key, never the superseded clearing entry as active
funding.

## Atomic future persistence transaction

The future implementation must execute one transaction with this order:

1. Recompute and revalidate authoritative bank, journal, receipt-match, and
   enrichment projections from current database state. Reject stale caller-
   supplied projections and any semantic-key disagreement.
2. Acquire a deterministic lock covering the scope, bank transaction, receipt,
   and match key in a stable order.
3. Insert or reuse `bank_receipt_matches`; reject any conflicting existing
   identity.
4. Reuse the compatible confirmed purchase, or create the one deterministic
   purchase event when no purchase exists.
5. Insert or reuse the one `business_event_bank_evidence` association.
6. Validate or create the same-scope financial-account to ledger-account
   mapping, including ASSET and currency constraints.
7. Create or reuse the one bank-funded ledger entry with the exact replacement
   shape.
8. Add receipt and bank source-provenance links without invalidating existing
   receipt links.
9. If a standalone fiscal entry is being refined, insert exactly one
   `ledger_entry_supersessions` row after checking active status, direct
   replacement uniqueness, and cycle absence.
10. Refresh bounded certification using active-ledger semantics, then commit.

Replay of the same authoritative input is idempotent. Any disagreement with
persisted semantic identity, ownership/scope evidence, ledger shape, or active
cardinality aborts the transaction and leaves all rows unchanged.

## Invariants

- one economic purchase, not bank purchase plus receipt purchase;
- one active monetary ledger entry;
- bank movement is the sole funding fact;
- receipt never creates a second cash flow;
- raw bank and receipt evidence remains immutable;
- OWNER evidence never proves payer or beneficiary;
- exact decimal money only, with no floating-point tolerance or FX conversion;
- no silent history rewrite;
- no destructive migration or historical backfill;
- deterministic, idempotent replay;
- existing receipt-only history remains readable;
- ambiguity, stale state, scope contradiction, or persistence conflict fails
  closed.

## Rejected alternatives

### Adding bank columns to receipt-only `business_event_evidence`

Rejected because that table is normalized around receipt/item foreign keys and
receipt normalization versions. Bank-match identity and bank provenance would
be nullable, semantically overloaded, and difficult to constrain as one-to-one.

### Mutating the standalone ledger entry or postings in place

Rejected because it destroys immutable receipt-only history and makes audit
replay unable to distinguish the old fiscal-clearing assertion from the later
bank-backed refinement.

### Keeping both fiscal-clearing and bank-funded entries active

Rejected because it double-counts acquisition funding and produces a second
monetary outflow for one economic purchase.

### Treating the receipt as a second funding source

Rejected because the receipt is independent purchase evidence and fiscal detail;
the bank movement remains the sole funding fact.

### Inferring payer from account OWNER

Rejected because OWNER proves source/account ownership context only. It does not
prove who paid a receipt, who benefited, or who is the counterparty.

## Explicit non-scope

This document does not add code, tests, a migration, grants, runtime wiring,
production writes, deployment, replay, backfill, receipt matching changes,
business-event persistence, ledger persistence, or certification writes.
