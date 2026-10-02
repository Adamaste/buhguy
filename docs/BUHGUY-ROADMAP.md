# BUHGUY Roadmap

This document describes the long-term direction of `Adamaste/buhguy`.

It is intentionally more stable than `docs/BUHGUY-CURRENT-HANDOFF.md`, which records the current operational point.

## Status legend

- **Implemented** — present in the repository and/or production path with established tests
- **Validation** — implemented but still being proven on real data/devices
- **Next** — nearest planned functional milestone
- **Planned** — intended architecture, not yet the active implementation target
- **Ongoing** — cross-cutting discipline that applies continuously

## Project goal

Build a personal financial/accounting system that combines independent evidence sources into a verifiable model of:

- receipts and purchased items
- bank cash flow
- business events
- accounts and balances
- double-entry accounting
- reconciliation and certification
- analytics and assistant-facing semantic views

The system should prefer explicit uncertainty over invented certainty.

Core rules:

- bank transaction != purchase
- receipt != cash flow
- source ownership != payer/beneficiary proof
- normalization must not destroy raw evidence
- reconciliation must record evidence and provenance
- accounting postings should be based on sufficiently supported business events

## Current position

The project already has a substantial receipt/FNS and accounting-proof foundation.

The active development area is the bank evidence path, specifically reliable Android notification capture on a real Samsung device.

Current sequence:

1. stabilize Android bank notification capture/delivery
2. implement bank-specific parsers and normalization
3. build reconciliation between independent evidence sources
4. expand account/balance and business-event semantics
5. integrate sufficiently proven events into accounting/ledger workflows
6. expand analytics, monitoring, and automation

The exact live blocker and next command-level action are maintained in `docs/BUHGUY-CURRENT-HANDOFF.md`.

---

## 1. Evidence-source foundation

**Status: Implemented / Ongoing**

The system treats each source as evidence rather than as the final accounting truth.

Source families include:

- FNS receipts
- Android bank notifications
- future bank APIs/imports
- future manual/mobile evidence capture

Each source should preserve:

- source identity
- observation timestamp
- source event identity
- raw/minimized evidence
- normalization status
- provenance
- deduplication/idempotency behavior

### Exit criteria

- evidence is durable
- duplicates are safe
- conflicting replays fail closed
- provenance is preserved
- secrets are excluded from evidence/logs

---

## 2. FNS receipt pipeline

**Status: Implemented foundation / production path**

Existing direction:

FNS source
-> source references/observations
-> canonical receipt
-> fiscal normalization
-> business-event graph
-> ledger/certification/reconciliation layers
-> analytics

Continue improving:

- source reliability
- receipt coverage/gap visibility
- normalization quality
- multi-person/source semantics
- self-service onboarding
- monitoring and recovery procedures

Do not collapse receipt evidence into bank evidence.

---

## 3. Bank ingestion backend

**Status: Implemented**

The backend supports:

bank source
-> authenticated immutable observation
-> normalized bank transaction

Established behavior includes:

- per-source device authentication
- source binding
- idempotent duplicate handling
- conflicting replay rejection
- least-privilege runtime access
- separate administrative provisioning

### Ongoing requirements

- retain strict least privilege
- keep provisioning separate from runtime ingestion
- maintain stable error contracts
- monitor authentication, retries, conflicts, and source freshness
- never expose raw secrets through semantic/assistant layers

---

## 4. Android bank collector transport

**Status: Validation**

Current architecture:

Android bank app
-> `NotificationListenerService`
-> package allowlist
-> minimized capture
-> Room durable outbox
-> WorkManager
-> HTTPS bank ingestion
-> observation
-> bank transaction

Already implemented:

- package allowlist
- durable outbox
- retry semantics
- stable deterministic source event identity
- encrypted device credential storage
- permanent APK signing
- safe in-place update path
- callback/capture/Room/enqueue observability
- listener lifecycle diagnostics
- master-only signed CI artifact

### Current validation goal

Prove reliable capture behavior across each supported bank/package on real devices.

Supported package set currently includes:

- Alfa Bank
- T-Bank
- Sber
- Yandex Bank
- VTB
- Ozon Finance

The active real-device blocker is maintained in the current handoff.

### Exit criteria

- supported-bank notifications are observed reliably
- no silent loss between Android callback and Room
- delivery retries are observable and bounded
- source freshness can be monitored
- app updates preserve configuration/credentials
- Samsung/OEM behavior is understood well enough for production operation

---

## 5. Bank-specific parsing and normalization

**Status: Next**

Once notification capture is reliable, replace RAW_ONLY behavior with versioned bank-specific parsers.

Extract only facts actually supported by the notification evidence:

- direction: `DEBIT` / `CREDIT` / `UNKNOWN`
- amount
- currency
- event time
- merchant/counterparty when present
- transfer/payment/refund/fee classification when present
- controlled account/card reference when present

### Rules

- parser must be package/provider-specific and testable
- raw observation remains immutable
- parser changes must not rewrite history silently
- unsupported fields stay unknown/partial
- notification wording changes must fail visibly, not produce invented values

### Acceptance suite

Build regression fixtures for every known notification format and edge case.

---

## 6. Account and money model

**Status: Planned**

A bank source is not necessarily a financial account.

Introduce/complete a model for:

- bank accounts
- cards linked to accounts
- cash
- credit/loan accounts
- other assets/liabilities as needed
- ownership/context separate from transaction-party proof

Money-flow totals are derived from observed transactions and explicit account identity evidence.

Provider-reported balance snapshots and balance-difference reconciliation are not an active roadmap stage. A balance difference must never be treated as proof of a missing transaction or classified cash flow; unseen operations can be incomplete, multiple, or offsetting.

### Requirements

- internal transfers between own accounts must not become expenses
- card identity and account identity must remain distinct where necessary
- unknown account mapping must remain explicit

---

## 7. Reconciliation layer

**Status: Planned; central future milestone**

Reconciliation connects independent evidence without pretending they are the same fact.

Example candidate relationship:

bank debit
<-> receipt
<-> purchase/business event

Potential signals:

- amount
- currency
- time window
- merchant/counterparty
- source/person context
- account context
- refunds/reversals
- explicit user evidence

Every proposed relationship should preserve:

- participating evidence ids
- reason/features
- confidence or certainty state
- provenance
- decision status
- manual override/correction where appropriate

### Rules

- no silent heuristic auto-match that becomes accounting truth
- absence of a receipt is not automatically an error
- one receipt may not always map one-to-one to one bank operation
- cash purchases and internal transfers require distinct treatment

---

## 8. Business-event model

**Status: Partial foundation / Planned expansion**

Build normalized business events only when supported by evidence.

Examples:

- purchase
- refund
- transfer
- income
- fee
- cash withdrawal
- cash deposit
- subscription charge
- internal transfer
- reimbursement

A business event may aggregate multiple independent evidence items.

Example:

purchase event
- fiscal receipt evidence
- bank debit evidence

Neither evidence item alone implies the other exists.

---

## 9. Double-entry ledger and certification

**Status: Existing foundation / Planned broader integration**

The repository already contains double-entry, certification, and reconciliation foundations for receipt/accounting workflows.

Future bank integration should feed the ledger only after the business event is sufficiently supported.

Example after proof:

Dr Expense
Cr Bank Account

### Rules

- unresolved events remain unresolved
- unbalanced entries fail validation
- ledger postings retain links to source evidence
- bank cash flow alone must not fabricate expense semantics
- certification/reconciliation should make missing proof visible

---

## 10. Classification and enrichment

**Status: Planned**

After event semantics are reliable:

- merchant normalization
- expense/income categories
- recurring payments
- subscriptions
- refunds
- fees
- transfer detection
- internal transfer recognition

Automated classification should retain:

- model/rule/source of decision
- confidence
- evidence
- ability to correct manually

Corrections should improve future classification without rewriting raw evidence.

---

## 11. Multi-person and shared accounting

**Status: Partial foundation / Planned**

Continue separating:

- source owner
- payer
- beneficiary
- purchase owner
- reimbursement party
- shared-expense participants

An `OWNER` relation on a source is context only.

Future support may include:

- personal vs shared purchases
- split expenses
- reimbursements
- household accounting
- transfers between people
- person-specific analytics

---

## 12. Manual/mobile evidence capture

**Status: Planned**

Support evidence that never appears automatically in existing sources.

Important case:

paper receipt / QR
-> mobile capture
-> fiscal identifiers
-> verification/fetch when possible
-> receipt observation
-> canonical receipt pipeline

This should reuse the same evidence architecture rather than create a separate shadow database.

Potential mobile responsibilities:

- QR scanning
- manual evidence submission
- source health/status
- permission diagnostics
- credential lifecycle/status
- pending-event visibility
- user onboarding

Business/accounting logic should remain server-side.

---

## 13. Analytics and semantic access

**Status: Partial foundation / Planned expansion**

Expose safe normalized views rather than raw payloads.

Future analytics:

- spending by period/category
- merchant analysis
- cash flow
- income vs expenses
- balances
- subscriptions
- recurring transactions
- refunds/fees
- reconciliation coverage
- receipt coverage
- unresolved evidence
- data-quality gaps

Assistant-facing semantic layers should exclude:

- authentication material
- unnecessary raw notification contents
- private operational internals

---

## 14. Reliability and observability

**Status: Ongoing**

Every ingestion source should provide:

- last successful ingestion
- source freshness
- pending backlog
- retry state
- duplicate/conflict counters
- authentication failures
- unexplained gap detection
- explicit permanent rejection
- health endpoint/monitoring where appropriate

Silent evidence loss is unacceptable.

For Android specifically, preserve callback-to-delivery stage diagnostics.

For FNS, preserve scheduled-sync and source-reference gap monitoring.

---

## 15. Security

**Status: Ongoing**

Principles already adopted and to preserve:

- least-privilege runtime DB roles
- administrative provisioning separated from runtime
- per-device credentials
- revocation support
- encrypted Android credential storage
- stable controlled Android signing
- secrets outside Git
- trusted-master-only signing secrets
- raw financial evidence minimized in logs
- reviewed production changes
- explicit audit trail for privilege/provisioning changes

Never solve operational friction by broadly granting production privileges.

---

## 16. Production operations

**Status: Ongoing**

Preferred path:

feature branch
-> PR
-> CI
-> review
-> merge
-> immutable artifact
-> controlled deploy/update
-> health/evidence verification
-> rollback path

Production operations should preserve:

- exact Git identity
- artifact hashes
- backups before destructive changes
- explicit migration/grant review
- monitoring after deployment

Android updates should use the permanent signing lineage and in-place update path.

---

## 17. Automation and assistant workflows

**Status: Planned after evidence quality is sufficient**

Potential automation:

- reconciliation suggestions
- missing-receipt detection
- missing-bank-evidence detection
- recurring-transaction detection
- anomaly detection
- budget tracking
- cash-flow forecasting
- account-health summaries
- unresolved-evidence queues

Automation must never convert a low-confidence inference into an unquestioned accounting fact.

---

## 18. Near-term execution order

Unless the current handoff says otherwise, the intended order is:

1. finish Android real-bank callback reliability diagnostics
2. prove supported-bank capture/delivery behavior
3. implement bank-specific parsers and parser regression fixtures
4. normalize direction/amount/currency/event semantics
5. model bank accounts/card references where evidence permits
6. implement reconciliation candidates between bank and receipt evidence
7. connect sufficiently certified business events to ledger flows
8. expand analytics and gap/quality monitoring
9. add manual/mobile evidence capture
10. add higher-level automation only after evidence/reconciliation quality is measurable

## Roadmap maintenance

Keep this document strategic.

Put changing SHA values, current blockers, device-test evidence, and the exact next action in:

`docs/BUHGUY-CURRENT-HANDOFF.md`

Update roadmap status only when a meaningful milestone changes phase.

Never commit secrets or raw sensitive financial payloads into either roadmap or handoff documentation.
