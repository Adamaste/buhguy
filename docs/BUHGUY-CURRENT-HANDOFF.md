# BUHGUY Current Handoff

This document is the operational starting point for a new ChatGPT/Codex session.

## Session bootstrap rule

This file is the authoritative operational handoff for a new ChatGPT/Codex session. A new session must not ask the user to reconstruct project history that is available here or in GitHub.

At the start of any technical work on `Adamaste/buhguy`:

1. read this file completely;
2. read `docs/BUHGUY-ROADMAP.md`;
3. verify the current GitHub `master`;
4. inspect only the relevant detailed docs/code/PR/CI needed for the active task;
5. continue from the explicit current blocker/next action below rather than restarting diagnostics.

Do not repeat closed stages. If this document disagrees with GitHub about code, merge status, CI, or artifacts, GitHub wins. After a meaningful completed stage, update this handoff in a reviewed PR before moving on.

- Last updated: 2026-10-01
- Current master: `0a6a97f1f8c594520f12bb22218320869edfe3ff`
- Current phase: Android source-provenance implementation is prepared from master for review; no production deployment has been performed for this change
- Current blocker: Yandex physical source provenance is currently lost in persisted envelopes. This change is limited to preserving optional source package/channel metadata; no classifier or parser change is in scope. The deployed runtime remains the prior artifact below
- Production artifact: exact master `58e2610406425aa7faf84080cf2ee77583b867c4`, 309 files, archive SHA-256 `f45269892ea3e536881b72023e8739f8995adef772d48f8b3212b43f9ce3591f`
- Current Yandex evidence: master-signed APK is installed; observation 18 / transaction 16 has provider `com.yandex.bank`; its full source event id exactly matches a current `ru.yandex.taximeter` record on `notification_channel_1` when using the stored event-time millisecond as postTime; credential use and backend creation are corroborated
- Current observability anomaly: fresh UI diagnostics still show the previous Alfa capture and delivery values; no raw notification content was retained, and the cause of this stale persistent state is not yet proven
- Current evidence: observations 72, 75, and 79 are RECONCILED to financial account 1 through historical replay provenance; observations and bank_transactions remain immutable and no backfill was performed
- Current Yandex status: normalizer v1 is deployed and unchanged
- Next action: Review and merge the Android source-provenance change, then deploy it through the immutable-artifact path. No new Yandex bank operation is required for this provenance stage; a later classifier strong-unknown decision remains separate. Study Yandex card-purchase evidence only when a real purchase occurs naturally; do not create artificial purchases. Do not perform historical replay/backfill or another Alfa research transfer. Ozon remains deferred. Sber outgoing direction remains `UNKNOWN`; Person 2/3, INTERNAL_TRANSFER, business events, and ledger work remain out of scope.

## Android source provenance handoff

The current GitHub master is `0a6a97f1f8c594520f12bb22218320869edfe3ff`;
the production artifact remains the separately deployed
`58e2610406425aa7faf84080cf2ee77583b867c4` release above until this change is
reviewed, merged, and deployed through the normal immutable-artifact path.

The Yandex corpus currently contains 71 transactions: 9 READY incoming
transfers, 14 READY purchases, and 48 PARTIAL rows; the latest observation and
transaction ids are 270 and 220. Physical source metadata was not preserved,
so observations 266-270 cannot safely be assigned to a Yandex source app or
role from the current envelopes. ADB is unavailable for this review, and no
new bank operation is required.

The model remains one canonical financial provider, `com.yandex.bank`.
`sourcePackage` and optional `notificationChannel` are the next transport
provenance fields; they do not prove ownership, event type, direction,
reconciliation, or that packages should be merged, and the channel is not
part of source-event identity. A later classifier strong-unknown decision is
separate. No Android configuration, parser, DB schema, production data, or
credential change is part of this stage.

## Alfa F5 partial normalizer

The read-only Alfa corpus review now covers 23 observations across four current
forensic top-level families: integer-title F5, decimal-title F5,
empty/companion, and other historical envelopes. The earlier exact structural
classification retained 11 historical subfamilies; this is a separate metric,
not the current forensic family count. Seven F5 primaries share one real-derived
four-section body skeleton,
with integer and comma-decimal(two digits) title variants. The active v3 staged
path requires title/body amount equality, title-case transfer/recipient anchors,
both proven masked-reference positions, uppercase `RUB`, and Android envelope
event time. It preserves `eventType=UNKNOWN`, `direction=UNKNOWN`, and unknown
reference kind; no ownership or card/account inference is performed. Unmatched
Alfa families and companions remain on generic normalization. Observation 260
failed closed under v2 without semantic corruption because the old synthetic
body grammar used lowercase anchors; v3 corrects only that evidence-backed
grammar. No additional research transfer or fresh Alfa E2E is required; the
post-deployment E2E has passed and Alfa is closed.

## Alfa F5 v3 production E2E closeout

Master CI run `36907264462` passed for master
`58e2610406425aa7faf84080cf2ee77583b867c4`. The immutable production
artifact contains 309 files and has archive SHA-256
`f45269892ea3e536881b72023e8739f8995adef772d48f8b3212b43f9ce3591f`.
The release manifest and installed file hashes matched, and the bank-ingestion
service remained healthy.

The fresh Alfa primary was observation `263` / transaction `213`; no separate
companion was observed. It matched the exact staged four-section v3 envelope:
title/body amount equality, RUB, Android event time, both reference segments,
and a masked reference were present. The controlled amount matched without
retaining the real amount in this handoff. The persisted result is
`normalizationStatus=PARTIAL`, `evidenceQuality=PARTIAL`,
`eventType=UNKNOWN`, `direction=UNKNOWN`, and `accountReferenceKind=NULL`.
Account resolution remains `UNKNOWN` with no financial account id, and no
payment-instrument or account/card identity inference was performed.

No historical rows were replayed or backfilled, and no accounting or identity
side effects were created. Alfa F5 is closed. The next provider stage is
Yandex transfer/top-up forensic; card-purchase evidence is deferred until a
real purchase occurs naturally.

## T-Bank top-up partial parser evidence

The T-Bank forensic corpus covered 51 historical observations across 22 exact
structural families. Two independent controlled top-up observations, `214` and
`217`, share one body family; `218` is a separate empty companion. The title is
absent in one sample and present in the other, so it is not required by the
parser. The exact proven body boundary is:

`Пополнение на <integer> ₽, счет RUB. <dynamic words> Доступно <comma-decimal> ₽`

The first integer-RUB position is proven transaction amount, the second
comma-decimal position after `Доступно` is a separate balance/availability
value and is ignored, and Android envelope `eventTime` is used for occurredAt.
The narrow `tbank-bank-normalizer-v1` is authorized only as `PARTIAL`; it must
preserve `eventType=UNKNOWN`, `direction=UNKNOWN`, and null account/card
references. No READY parser or ownership inference is authorized. No further
controlled top-up sample is required.

## T-Bank top-up partial normalizer production E2E

The exact master `8e56566717e346fb56371ddcb9216de68777bade` was promoted
through the immutable runtime procedure after a dependency-closure install.
The service is healthy, schema 016 remains current, and the pre-E2E baseline
was observation `218` / transaction `172`.

One fresh Alfa-to-T-Bank notification arrived after that baseline as
observation `221` / transaction `175`. It was the primary T-Bank top-up
notification; no companion was observed. The deployed
`tbank-bank-normalizer-v1` extracted the proven integer RUB transaction amount
and Android post-time, returning `PARTIAL` with `eventType=UNKNOWN` and
`direction=UNKNOWN`. The amount matched the user-confirmed operation, but the
real amount is intentionally not retained in repository artifacts.

The persisted event remained fail-closed for account identity: no account or
card reference was inferred and account resolution stayed `UNKNOWN` with
`OBSERVED_PROVIDER_REFERENCE_UNRESOLVED` provenance. Historical rows were not
changed, and no replay, backfill, ledger, business event, or internal transfer
was created. This closes the T-Bank top-up partial-parser E2E; the next
provider target is Alfa.

Ozon research is deferred because additional paid notification experiments are
not desirable; its parser remains unauthorized. The next operational step is
incremental Alfa provider evidence, beginning with read-only corpus forensic.
A separate real T-Bank card-purchase sample can be investigated later when it
naturally occurs.

## Bank Assistant semantic layer activated

PR #48 is merged in master `423f978d0783811463d36fd8fcda84019248822d`;
master CI #171 (`36752374713`) passed. The approved semantic SQL was deployed
from that exact master with no migration, grant expansion, or bank-row rewrite.
The `chatgpt_reader` role can select the semantic views while raw bank tables
and writes remain blocked. BlazeSQL selection was refreshed to all 30
`chatgpt_accounting` views, and the assistant read-path smoke test passed.

A fresh real Sber incoming operation was visible through the assistant path as
`READY / INCOMING_TRANSFER / CREDIT / EXACT` for Person 1's proven account
evidence. The Bank Assistant is therefore usable for Person 1 proven incoming
transfers. `READY_TO_ASK_CHATGPT_ABOUT_TRANSFERS=YES`.

The active functional cycle remains Person 1 multi-bank operation coverage.
Sber now has two distinct production-proven normalization paths: the exact
incoming family remains `READY / INCOMING_TRANSFER / CREDIT / EXACT`, while
the outgoing-shaped v4 family preserves only the proven amount, `RUB`,
payment-account reference, and Android event time as `PARTIAL`. Its
`eventType` and `direction` intentionally remain `UNKNOWN`.

The earlier outgoing corpus review and controlled-sample campaign are closed
research stages. They established the v4 grammar and account-reference
stability; do not restart them or collect another amount-only Sber sample.
Any future Sber `DEBIT` classification requires an independent structural
marker or evidence source rather than the fact that a controlled user action
was known to be outgoing.

## Sber normalizer v4 production deployment and Person 1 outgoing E2E

PR #50 was squash-merged into exact master
`25ecffb0d794bd9856a1355c8cadda9d1fa32240`. Master CI run
`36852085746` passed all jobs, including `test`, `android`, and
`android-signed`.

The backend runtime was promoted from that exact master using an immutable
304-file artifact with archive SHA-256
`11ef406534774f4e16cfb61dff8fcb01d383cffaff39e9c0b6d89deb4607ca5f`.
Artifact integrity, pre-deploy backup, atomic promotion, installed manifest,
installed hashes, service health, and active release identity all passed.
No DB migration, analytics SQL, grant, credential, Android, historical replay,
or backfill operation was performed as part of deployment.

A fresh Person 1 Sber outgoing-shaped production E2E was then performed after
the pre-E2E baseline observation `204` / transaction `158`. Ordinary
ingestion created observations `206-209` and transactions `160-163`:

- primary observations `207` and `208` normalized with
  `sber-bank-normalizer-v4` as `PARTIAL` / `PARTIAL`;
- both primary projections extracted the user-confirmed transaction amount and
  `RUB`; the exact real amount is intentionally not retained in repository
  artifacts;
- both primary projections resolved to `financial_account_id=1` with
  account-resolution state `EXACT`;
- both primary projections preserved `eventType=UNKNOWN` and
  `direction=UNKNOWN`, proving that v4 does not invent outgoing/debit
  semantics;
- companion observations `206` and `209` remained separate
  `PARTIAL`/unknown evidence with no transaction amount or account
  resolution.

This closes the Sber v4 amount/currency/account-reference production E2E.
No further controlled amount sample is required. Sber `DEBIT` remains a
separate unresolved evidence question and requires an independent structural
marker or evidence source before classification.

## Sber normalizer v4 partial outgoing evidence

The outgoing evidence research is complete for the narrow partial envelope.
Controlled primary samples are observations `193/195`, `201`, and `204`; the
reference-only companions are `194/196`, `202`, and `203`. The third controlled
sample used a unique integer RUB amount. It matched the integer monetary
position, not the independent comma-decimal balance position; the exact real
amount is intentionally not retained in repository artifacts.

The v4 parser may preserve only these proven facts for the exact provider,
adapter, schema, title/body structure: integer transaction amount, `RUB`, the
stable payment-account `MASKED_ACCOUNT ••0271` position, and event time from
Android `postTime`. It must return `PARTIAL` with `eventType=UNKNOWN` and
`direction=UNKNOWN`. No `DEBIT`, outgoing event type, purchase, internal
transfer, business event, ledger posting, historical replay, or backfill is
allowed. The parser is now deployed and production-validated under exactly
those partial semantics.

## Sber normalizer v3 current-format evidence

The two newest controlled primary Sber incoming observations are `147` and
`154`; their separate reference-only companions are `149` and `152`. The two
primary samples share one privacy-safe structural family:

- title: `Перевод по СБП от <sender>.` with an exact final period;
- body: `+ <integer> ₽ — Баланс: <grouped comma-decimal balance> ₽ Плат. счёт ••<four digits>`;
- the first integer RUB token is the transaction amount;
- the grouped comma-decimal field is a separate balance and is ignored;
- the payment-account suffix is canonicalized as `MASKED_ACCOUNT`;
- event time remains the Android notification `postTime` carried as envelope
  `eventTime`.

The active incoming parser revision is `sber-bank-normalizer-v4`, scoped to provider
`ru.sberbankmobile`, adapter `android-notification`, and schema version `1`.
It accepts this incoming envelope and the separately proven outgoing-shaped
partial envelope. Previous v1/v2 Sber envelopes remain
documented and preserved as immutable historical evidence, but are not active
runtime formats under v4. No historical `bank_transactions` are rewritten and
no backfill is permitted.

## Sber normalizer v3 production deployment and final Person 1 E2E

The v3 runtime was promoted from exact master
`bfdeea3e5cc62ff65c256725b25b5e1e33027856` using an immutable 269-file
runtime artifact with archive SHA-256
`360a98738450b09d8873db60000bc0c5f116a7e6a36d51fcbe8d0986457d3d97`.
The installed manifest and service path match the exact release. Schema
`016_runtime_identity_lookup_grants.sql` remained current; no migration,
grant, credential, or Android configuration change was performed.

The final fresh Person 1 ingestion passed without historical replay or
backfill:

- primary observation `161` and transaction `128` were `READY`,
  `INCOMING_TRANSFER`, `CREDIT`, RUB, and `sber-bank-normalizer-v3`;
- the proven payment-account evidence was `MASKED_ACCOUNT ••0271`;
- ingestion-time resolution was `EXACT` to `financial_account_id=1` with
  provenance `OBSERVED_PROVIDER_REFERENCE`;
- companion observation `164` and transaction `129` remained independent
  `PARTIAL`/`UNKNOWN` evidence and were not combined with the primary event.

Historical observations and transactions remained unchanged. No manual or
historical resolution, INTERNAL_TRANSFER, business event, ledger posting,
identity inventory change, grant change, or credential change was performed.
The next phase is the Bank Assistant read-only semantic layer for the usable
MVP. Person 2/3 onboarding and outgoing-transfer parser work remain out of
scope.

## Bank Assistant semantic-layer scope

The planned assistant surface is read-only and transaction-grain. The bank
transaction view exposes normalized event semantics and explicit account and
payment-instrument resolution states, while separate views expose aggregated
source-person capture context without treating it as account ownership. An
unresolved transaction remains visible as `UNKNOWN`; a card reference never
infers an account; raw notification/payload identifiers and credentials are
not exposed.

The provider matrix is intentionally narrow: Sber incoming/CREDIT v4 is the
current proven bank envelope, Yandex remains deployed, and T-Bank, Alfa, Ozon,
and VTB require future incremental evidence. No semantic-layer deployment,
backfill, ledger posting, business event, internal-transfer matching, phone
change, or production mutation is part of this review.

## Sber final E2E fail-closed and corpus forensics

The final controlled Person 1 Sber E2E was intentionally retained
fail-closed. Observation `134` and its transaction projection were persisted
as `PARTIAL`/`UNKNOWN`; observation `135` was a separate reference-only or
summary event and was not combined with `134`. No manual resolution, backfill,
accounting event, identity change, or other state mutation was performed
beyond ordinary ingestion of the two notifications.

The read-only corpus scan covered 17 immutable Sber observations. Observation
`134` has the following privacy-safe structural fingerprint:

- title: one unproven literal envelope with one or more non-static segments;
  no proven incoming marker, exact fixed prefix, or exact fixed suffix can be
  safely isolated from this singleton;
- body: incoming marker, integer RUB-symbol amount, a separate grouped
  comma-decimal balance field, and the exact payment-account marker;
- account reference: the already established `MASKED_ACCOUNT` suffix `0271`;
- punctuation: the title contains a period code point, but that punctuation
  does not establish a semantic title boundary.

Observation `134` is a singleton structural cluster (`[134]`) with one
timestamp shape, one amount shape, one balance shape, and one title dynamic
value. Existing proven Sber incoming observations (`72`, `75`, `79`, and
`128`) do not establish the same title envelope. Therefore the current
evidence did not justify an exact v3 grammar at that time: a broad title
`contains` heuristic or a guessed balance rule would have risked a false
positive. This is retained as historical forensic context; the two later
controlled samples are documented in the current v3 section above.

This remains historical forensic context. The later controlled v3 samples and
the final fresh-ingestion E2E establish the active current-format contract;
observation `134` remains correctly fail-closed and is not backfilled.

## Sber normalization v2 production deployment

The Sber v2 runtime was deployed from exact master
`ccefe24282bcba4e519e0f27feb7e29e33fd95f0` using the immutable 267-file
runtime artifact with archive SHA-256
`257ac8a1fda22c9abce54f63466ef4a41a1249a466b72c0d6cfa8cc5f38b9dac`.
The installed release manifest matches the staged artifact and the active
systemd service runs from the exact release. Schema `016_runtime_identity_lookup_grants.sql`
remained current; no migration, grant, credential, or configuration change was
performed.

Read-only in-memory replay through the deployed code passed for observation
`128`: `READY`, `INCOMING_TRANSFER`, `CREDIT`, RUB, amount present, and
`sber-bank-normalizer-v2`. Observation `129` remained `PARTIAL`/`UNKNOWN`
without a reference and was not promoted. Historical observations `72`, `75`,
and `79`, transaction projections `101`/`102`, Person 1 identity/reference
inventory, and resolution rows were unchanged. No backfill, replay persistence,
ledger posting, business event, or internal-transfer matching was performed.

The next step is review and controlled deployment of the v3 current-format
parser. T-Bank and Ozon parser coverage remain future incremental work; Alfa
and VTB remain deferred. No historical v1/v2 row is backfilled.

## Sber normalizer v2 historical evidence slice

The controlled Person 1 E2E produced observation 128 with provider
`ru.sberbankmobile`, a valid Android post time, and a body matching the proven
incoming-transfer contract including the Person 1 account reference. The
controlled Sber evidence set is four incoming observations in total: three
historical/proven v1 samples plus observation 128 as the separate v2 checkmark
sample. Deployed Sber v1 rejected observation 128 only because its title used
the newly proven exact envelope `✅ Поступление от <sender>`. Observation 129
was separate reference-only/summary evidence with no title/body and remains
unsupported.

The feature branch for Sber normalizer v2 added only that exact checkmark title
envelope. Those v1/v2 formats remain immutable historical evidence and are no
longer active under the current v3 contract. No historical backfill is
performed.

## Automatic identity resolution production deployment

PR #41 is merged in master commit
`04e5dc3edcf9846a78e04216e9926244538e3105`. The immutable production runtime
artifact was built from that exact commit with archive SHA-256
`207330b8d1b2d4a7b2d500ea8d42e4072e43ba47b9c452e15b7895dee212b317`.

Production validation completed successfully:

- the release manifest matched the staged and installed runtime files;
- `finance-bank-ingestion.service` runs from the exact release and `/healthz`
  returns HTTP 200;
- migration `016_runtime_identity_lookup_grants.sql` was applied through
  `scripts/migrate-prod-only.mjs` using the administrative PostgreSQL peer path;
- the FNS timer remains `enabled/active`, while the sync service is inactive;
- observations and bank transactions remain `98/98` after deployment;
- account-resolution rows remain `22` (`RECONCILED=3`, `UNKNOWN=19`), with
  logical coverage `98 total / 3 resolved / 95 unresolved` and invariant PASS;
- payment-instrument resolution rows remain `0` and historical observations
  `72/75/79` remain reconciled by historical replay provenance;
- runtime identity lookup grants are present, forbidden bank provisioning and
  broad bank transaction grants remain denied, and unrelated grants were not
  changed.

No historical backfill, new bank operation, phone use, ledger posting,
internal-transfer matching, business event, credential mutation, or source
mapping change was performed. The two additional pre-deploy observations were
verified as ordinary runtime notification ingestions with `UNKNOWN` and
`INGESTION_DEFAULT` resolution.

The next operational step is a controlled Person 1 E2E using existing
provisioned evidence. Do not infer ownership from source context alone.

## Automatic new-ingestion identity resolution (deployed)

The deployed runtime resolves only new bank transactions and does not change
existing production rows. A unique provider-scoped account
reference can produce `EXACT`; no reference, zero candidates, multiple
candidates, card-only evidence, or zero/multiple accounting scopes remain
`UNKNOWN` with explicit provenance. Card references may resolve a payment
instrument separately and never infer an underlying financial account.

The observation, bank transaction, and resolution rows are written in one
transaction. Duplicate and source-event conflict semantics are unchanged. No
historical backfill, ledger posting, internal-transfer matching, UI, or
production deployment is part of this proposed state. Runtime lookup grants are
defined by migration 016 and remain least-privilege; administrative provisioning
and resolution paths are unchanged.

## Payment instrument identity foundation (feature branch)

The current user-confirmed inventory belongs to `person_id=1`, but production
provisioning remains separate. This branch adds standalone payment-instrument
identity, explicit card person relations, provider-scoped card references, and
an optional card-to-account link. The same masked suffix in an account and a
card reference is not treated as a link. Card reference resolution is separate
from financial-account resolution and remains fail-closed when ambiguous.

The user has confirmed that all cards and accounts discovered so far belong to
Person 1. After this branch is merged and migration 015 is deployed, the first
operational sequence is:

1. provision the confirmed Person 1 cards/accounts and explicit evidence;
2. run controlled real-operation E2E and verify evidence, transaction, identity,
   and reconciliation layers;
3. verify the resulting read-only ChatGPT semantic answers.

Only after the complete Person 1 E2E is accepted should Person 2 be onboarded:
connect its source/device, verify notification visibility, discover new
card/account identities, link them first to Person 2 context, obtain explicit
user ownership confirmation, and run a short E2E regression. Person 3 follows
through the same reviewed flow. No Person 2 or Person 3 provisioning is part
of this stage.

## Historical bank-account evidence resolution

The feature branch `feat/historical-bank-account-resolution` adds an
administrative `bank-account resolve-historical` command. It is read-only by
default and accepts only an observation id. It verifies the immutable payload
hash, replays the current normalizer, compares normalized fields with the
persisted transaction, enforces one accounting scope, and derives a unique
provider/reference candidate.

An explicit `--persist` can change only an existing `UNKNOWN` resolution to
`RECONCILED`, with provenance `HISTORICAL_OBSERVATION_REPLAY`. It never changes
the observation or bank transaction, creates ownership/reference evidence,
backfills, posts ledger entries, or performs internal-transfer matching.
Missing, ambiguous, hash-mismatched, non-READY, compatibility-conflicting, and
multi-scope cases fail closed. The historical resolver was deployed from master
`9426cdf374416ea1e7de7b0ef806a63d3f8445e6` using immutable artifact SHA-256
`e28f1486ef63ac8d2eb9a77d4f361520275724628a6a56164b0f40e59b575636`.
The later docs-only merge `b67a6c68bb2ae467dd2f825158a8ed5f0839a4ca` is not
the deployed resolver SHA.

Production validation completed with schema migration `014` unchanged and no
grant changes. Read-only dry-runs for observations `72`, `75`, and `79` all
passed with provider `ru.sberbankmobile`, reference `MASKED_ACCOUNT ••0271`,
one candidate, account `1`, and compatibility `PASS`. Controlled persistence
then changed only their account-resolution rows to `RECONCILED` with
provenance `HISTORICAL_OBSERVATION_REPLAY`. The immutable observation payload
hashes and selected bank-transaction fingerprints were unchanged. A repeated
persist for observation `72` returned `ALREADY_RECONCILED` and preserved
`resolved_at`.

Coverage after validation is 81 total, 3 resolved, 78 unresolved, with 3
`RECONCILED`, 0 `EXACT`, 0 `MANUAL`, and 78 `UNKNOWN`; the coverage invariant
passes. No bank transaction backfill, INTERNAL_TRANSFER, business event, or
ledger posting was performed.

## Sber normalization v1 production validation

PR #28 and the corrective evidence-contract fix are merged in master commit
`019b89102ca91d91cd9f6b2db1647e74cc7bad95`. The corrective runtime was
promoted from an immutable LF-normalized 39-file closure with artifact SHA-256
`9c8d81c5f55d9c068133265efc6cf70cdf07345af22062f1a15727ec7fe843d1`.

Deployment validation completed for:

- exact staged and installed manifest hashes;
- `/healthz` HTTP 200 with `{"status":"ok"}`;
- JavaScript syntax, module imports, and CLI smoke;
- schema unchanged with migration `012_bank_transaction_event_type.sql` already current;
- timer restored to `enabled/active` and sync service left inactive after deployment;
- no migration execution, backfill, phone use, credential mutation, grant change, or new bank operation.

The deployed and validated Sber envelope is intentionally narrow:

- provider `ru.sberbankmobile`;
- adapter `android-notification`;
- schemaVersion `1`;
- exact proven incoming-transfer title forms only;
- first integer-ruble transaction amount token;
- a separate balance monetary field is ignored;
- event time from Android notification `postTime`.

Read-only in-memory validation against exact controlled production observations
completed successfully without exposing payload text or changing the database.
Observations `72`, `75`, and `79` each returned `INCOMING_TRANSFER`, `CREDIT`,
RUB, amount present, `READY`, and `sber-bank-normalizer-v1`. The event time was
derived from the stored Android notification event time. Related summary
observations `74`, `76`, and `80` remained `PARTIAL`/`UNKNOWN` and were not
promoted to `READY`.

This closes the Sber parser research gate for the proven v1 format. No
historical observation was updated, re-ingested, or backfilled.

Yandex normalizer v1 remains deployed and its regression suite remains passing.
T-Bank and Ozon parser coverage remain future incremental work; Alfa and VTB
remain deferred. The next phase is `USABLE_MVP`, focused on a daily-use view
of receipts, bank transactions, and explicit READY/PARTIAL/UNKNOWN evidence
states rather than another provider parser.

## Yandex normalization v1 production deployment

The merged Yandex normalization release was promoted from master commit
`bdf924f1d8a47ea9e5d204a3f1c25b7873e93801` using an immutable LF-normalized
artifact. The deployed artifact SHA-256 was
`03b1b5dd8578543a646c82c1b82dba97afc39ae72dffeab33911e1e5b8cb8469`.

Production validation completed successfully:

- runtime manifest hashes matched the staged artifact after promotion;
- migration `012_bank_transaction_event_type.sql` was applied through the
  existing migration implementation;
- `bank_transactions.event_type` is present and existing transaction 16 is
  `UNKNOWN`; no historical normalization backfill was performed;
- observation 18 metadata and payload fingerprint remained unchanged;
- observation and transaction counts remained 16 and 16;
- an in-memory dry-run of observation 18 returned
  `INCOMING_TRANSFER`, `CREDIT`, `RUB`, `READY`, using
  `yandex-bank-normalizer-v1`;
- `/healthz` returned HTTP 200;
- runtime privileges remained least-privilege, including table-wide
  `SELECT` denied on `bank_transactions` and column-level `SELECT(id)`
  retained for `RETURNING`;
- the FNS timer was restored as `enabled/active` after validation. No manual
  sync or new bank operation was performed during this deployment.

The deployment did not change phone state, Android configuration, device
credentials, Datadog configuration, or database grants. Observation 18 was
not backfilled; the dry-run only validated parser behavior in memory.

PR #24 is merged. T-Bank remains policy-blocked by its notification permission
state; this deployment did not change that device policy. The next functional
stage is bank coverage and provider parsers for Alfa, Sber, VTB, Ozon, and
T-Bank, with each parser kept fail-closed and evidence-preserving.

## Bank account resolution foundation production deployment

PR #32 is merged in master commit `e8940ff67ceefa1127729e0325abe5df65e68fb8`.
The immutable production artifact was built from that exact commit with
archive SHA-256
`0c68e31430a8b488e98d8cd7d663498225c09f2e912b745294b05dbd00d24e4d`.

Production validation confirmed:

- migration `013_bank_account_resolution_foundation.sql` is applied;
- `/healthz` returned HTTP 200 and `finance-bank-ingestion.service` is active;
- `bank_transactions` remained 79 before and after deployment;
- `bank_event_observations` remained 79 before and after deployment;
- no historical source evidence or resolution rows were changed and no
  backfill was performed;
- the 79 unresolved transactions remain explicit `UNKNOWN`, with coverage
  invariant PASS;
- the runtime role has only `INSERT` on
  `bank_transaction_account_resolution`; `SELECT`, `UPDATE`, and `DELETE`
  remain denied;
- no phone use, new bank operation, ledger posting, internal-transfer
  matching, or UI work was performed.

The semantic boundary is unchanged: source/device `OWNER` context never
establishes financial-account ownership. `EXACT` requires proven
provider/reference evidence and fails closed for zero or multiple candidates.
New bank transactions default atomically to `UNKNOWN`.

The intended next chain is:

```text
bank transaction
-> financial account resolution
-> internal-transfer reconciliation
-> business event
-> ledger Dr/Cr
-> ChatGPT semantic access
```

Operational note: `scripts/migrate-prod-only.mjs` had a path defect discovered
during migration 013 deployment. PR #34 corrected the wrapper to resolve the
repository migrations directory independently of caller cwd; migration 014
was subsequently applied through that corrected wrapper using administrative
PostgreSQL peer access.

## Bank account resolution operationalization

PR #34 is merged in master commit
`d4b6f1337fcd450569868127d7b144eb7d14e7c3`. Its immutable LF-normalized
production artifact has archive SHA-256
`0b8a103d9ad988be4ce4abd1f10b49ee1edf28934afb89d3a5a15e640d0dd7e6` and is
deployed at `/opt/accountant/releases/d4b6f1337fcd450569868127d7b144eb7d14e7c3`.

Production validation completed successfully:

- migration `014_bank_transaction_account_reference_kind.sql` was applied
  through the corrected `scripts/migrate-prod-only.mjs` wrapper using the
  administrative peer path;
- the wrapper was validated from a non-repository caller context and the
  staged/installed manifest hashes matched the exact master artifact;
- `finance-bank-ingestion.service` is active and `/healthz` returns HTTP 200;
- the FNS timer was restored to `enabled/active`, with no manual sync run;
- `bank_transactions` and `bank_event_observations` remained at 81/81;
- all 81 historical `account_reference_kind` values remain NULL; no historical
  reference projection or backfill was performed;
- runtime grants were not broadened and remain limited to `INSERT` on
  `bank_transaction_account_resolution` for unresolved ingestion rows.

Migration 014 adds nullable `bank_transactions.account_reference_kind` with
controlled values `MASKED_ACCOUNT`, `MASKED_CARD`, and `OTHER`; historical rows
remain valid and no backfill is permitted. Sber's proven `Плат. счёт ••dddd`
structure is canonicalized as four digits plus `MASKED_ACCOUNT`; Yandex remains
without account-reference evidence.

The operator CLI must use an administrative/peer-access identity, never the
`receipt_collector` runtime role. `EXACT` remains restricted to provider,
reference kind, reference value, and unique accounting-scope evidence;
missing, zero, or multiple candidates fail closed. Manual resolution requires
an explicit reason and cannot assert `EXACT`.

Read-only deployed CLI smoke passed for `bank-account list` and
`bank-account coverage` before provisioning. The account inventory was empty
at precheck and coverage reported 81 unresolved `UNKNOWN` transactions.

In-memory validation of the stored controlled Sber observations 72/75/79
returned `INCOMING_TRANSFER`, `CREDIT`, RUB, `READY`,
`sber-bank-normalizer-v1`, and `MASKED_ACCOUNT` with the same safe masked
reference. Summary observations 74/76/80 remained fail-closed `PARTIAL`/
`UNKNOWN` without an invented reference. Yandex behavior remains unchanged.

The ownership barrier remains active for all unconfirmed accounts: source/device
`OWNER` context is capture and accounting context only, not financial-account
ownership proof. No payment instrument or manual resolution was created.

## Sber account provisioning

On 2026-09-29 the user explicitly confirmed that `person_id=1`,
`legacy-current-user`, is Adam in this accounting context and that Sber masked
account `••0271` belongs to Adam. This is manual user evidence, not an
inference from device or bank-source ownership.

One atomic administrative transaction provisioned:

- financial account `1`: Sber, provider `ru.sberbankmobile`, currency `RUB`,
  display `Sber ••0271`;
- one `OWNER` relation to person `1` with provenance `USER_CONFIRMED`;
- one account reference `ru.sberbankmobile / MASKED_ACCOUNT / 0271`.

No payment instrument was created because the evidence proves an account
reference, not a specific card. Historical bank transactions and immutable
observations were not updated, re-ingested, or backfilled. Coverage remains
81 total and 81 `UNKNOWN`; historical resolution rows remain unchanged.

The next step is reviewed historical resolution for controlled Sber
observations 72/75/79 using immutable observation evidence and explicit
provenance. `INTERNAL_TRANSFER` reconciliation remains out of scope until
both sides of an own-account transfer have proven account identity.

## Person 1 account and card identity provisioning

Migration `015_payment_instrument_identity.sql` was applied in production
through the administrative migration wrapper. The exact master release
`982afaaf076c2ff47526485d85fe185569c7cdf2` was promoted from immutable
artifact SHA-256
`4468588f0afd47f7dfea2c6e16c0b0009c11b12141de0f0e530c7e0e9bbff46f`.
Production validation returned `/healthz` HTTP 200, an active
`finance-bank-ingestion.service`, and an enabled/active FNS timer.

The user-confirmed Person 1 inventory is now provisioned:

- financial accounts `1` Sber `••0271`, `2` Alfa `••3978`, and `3` Alfa
  `••8451`, each with one `OWNER` relation to person 1 and a
  `USER_CONFIRMED` provenance;
- standalone payment instruments `1`/`2`/`3` for Alfa cards `••1913`,
  `••5580`, and `••8451`, plus `4`/`5` for Yandex cards `••4297` and
  `••9615`, each with one `OWNER` relation to person 1 and no financial
  account link;
- account/card references were created with their proven provider and kind.

The Alfa account `••8451` and Alfa card `••8451` remain distinct identities;
no card-to-account links were created. Accidental duplicate Yandex
instruments `6`/`7` and references `9`/`10` were removed in one targeted,
precondition-checked administrative transaction; canonical instruments
`4`/`5` and references `7`/`8` were preserved.

Observations, bank transactions, account resolutions, historical Sber
resolutions `72`/`75`/`79`, grants, credentials, and source/person links were
not changed by provisioning or cleanup. No backfill, transaction resolution,
internal-transfer matching, business event, or ledger posting was performed.
The next development step is automatic fail-closed identity resolution for
new ingested transactions containing proven references. Controlled real-bank
E2E must wait until that code slice is merged and deployed.

## Read next when needed

Detailed architecture and operating contracts already live in:

- `README.md`
- `docs/OPERATIONS.md`
- `docs/android-bank-notification-collector.md`
- `docs/bank-device-auth.md`
- `docs/bank-ingestion-data-contract.md`
- `docs/bank-source-provisioning.md`

Relevant implementation history is in PRs #14 through #21. Do not duplicate those documents here unless the operational state depends on a result that is not obvious from code.

## Project invariants

The project combines independent financial evidence sources into a verifiable accounting model.

Key semantic rules:

- bank transaction != purchase
- receipt != cash flow
- source/person ownership is context, not proof of payer or beneficiary
- raw evidence and normalized projections remain separate
- reconciliation must preserve evidence, provenance, reason, and uncertainty
- unknown/partial is preferable to guessing

The existing receipt/FNS pipeline and the newer bank cash-flow pipeline are intentionally separate evidence paths that may later be reconciled.

## Bank ingestion backend: proven

The production bank-ingestion path is already implemented and has passed synthetic E2E.

Proven behavior:

- first valid event -> HTTP 201 `created`
- exact replay -> HTTP 200 `duplicate`
- same source event id with changed payload -> HTTP 409 `SOURCE_EVENT_CONFLICT`
- conflict creates no extra observation/transaction
- authenticated source binding works
- observation creation works
- normalized bank transaction creation works
- duplicate handling is idempotent

Do not restart backend design work merely because the current Android callback test fails.

## Production privilege history

Runtime DB role: `receipt_collector`.

It is intentionally least-privilege.

Previously fixed issues included narrowly scoped access for runtime authentication/ingestion, including `UPDATE(last_used_at)` on device credentials and `SELECT(id)` where required by `RETURNING`.

PR #17 removed an unnecessary observation row lock so ingestion works under the restricted runtime role without granting broad table access.

Important boundary:

- runtime ingestion must **not** receive provisioning privileges such as `INSERT` on `bank_device_credentials`
- device credential provisioning is an administrative operation
- when a replacement credential was needed, it was provisioned one-shot through PostgreSQL peer auth as `postgres`, without changing runtime grants

Do not broaden production grants to solve application problems.

## Android device/source state

Expected physical device:

- model: Samsung SM-S938B
- ADB serial: `R5GL30GK60F`

Collector package:

- `com.adamaste.buhguy.bankcollector`

Bank source:

- `android-adam-samsung-s938b`
- source type: `ANDROID_NOTIFICATION`
- source is associated with the existing accounting person context

Server endpoint:

- `https://v3234257.hosted-by-vdsina.ru/api/v1/bank/events`

Configured allowlist:

- `ru.alfabank.mobile.android`
- `com.idamob.tinkoff.android`
- `ru.sberbankmobile`
- `com.yandex.bank`
- `ru.vtb24.mobilebanking.android`
- `ru.ozon.fintech.finance`

There may be a second ADB endpoint shown as `offline`. Use the explicit physical target when running ADB commands:

`adb -s R5GL30GK60F ...`

## Device credential state

A replacement device credential was created during the signing migration and is active for source `android-adam-samsung-s938b`.

The old credential has intentionally not yet been revoked.

The replacement token was stored safely and entered into the Android UI without printing it. Do not log, print, recommit, or recreate it unless a new security event requires rotation.

The replacement credential has already been used successfully by a real bank delivery, so authentication is not the current blocker.

## Android signing: closed

The old installation originally used an ephemeral debug signing certificate, which prevented safe in-place updates from CI builds.

PRs #19 and #20 established permanent release signing for trusted `master` builds.

Stable certificate SHA-256:

`cb619643bbfb6b9235c85c560ba26967d2ca0f28db01fb6a7b9b3d6be484486a`

CI verifies the signed APK certificate before artifact upload.

The one-time controlled uninstall/reinstall migration has already been completed. Current and future application updates must normally use:

`adb install -r`

Do not propose another uninstall/reinstall merely because older debug-signing history exists.

## Android observability history

PR #18 introduced safe capture diagnostics around:

- `CAPTURED`
- `INSERTED`
- `DUPLICATE`
- Room insert error
- enqueue error

A diagnostic blind spot was then discovered: the original `BankCapture` entry happened only after preferences/allowlist/capture processing, so absence of `CAPTURED` did not prove absence of `onNotificationPosted()`.

PR #21 fixed that blind spot and is merged in current master.

Current observable chain includes:

- listener connected/disconnected
- callback entry
- filtered/not-allowed
- capture-null
- captured
- inserted/duplicate
- Room error
- enqueue error

Callback entry is recorded before preferences and allowlist evaluation.

Persistent UI diagnostics include last callback and listener lifecycle in addition to last capture, pending events, and last successful delivery.

A follow-up review restored separate enqueue error diagnostics and their regression test before PR #21 was merged.

## Stable PR #21 build installed

PR #21 merge SHA:

`77be9493d78076247f590935fd02865e7f175da3`

Master CI run:

`36324042145`

Signed artifact:

- name: `buhguy-bank-collector-signed`
- artifact id: `10933711781`
- APK SHA-256: `e3ba6dcd7a6152f1ccc9122cec782549b14f40d79ab15087968348edf67982b0`
- certificate matches the stable certificate above

This APK was already installed **in place** with `adb install -r`.

Post-update checks passed:

- config preserved
- source key preserved
- server URL preserved
- allowlist preserved
- credential preserved
- pending = 0
- notification access enabled
- listener connected
- no uninstall
- no app-data clear

## Synthetic callback test: passed

A harmless synthetic notification was posted from `com.android.shell`.

Observed:

- `CALLBACK_ENTRY_FOUND=YES`
- `FILTERED_NOT_ALLOWED_FOUND=YES`
- callback package matched
- Room unchanged
- pending remained 0
- no Android runtime crash

Conclusion: Android NotificationManager -> collector NotificationListenerService -> `onNotificationPosted()` -> allowlist filtering is proven to work in this installed build.

Do not repeat this test unless a later change invalidates that proof.

## Real bank proof: Alfa passed

A real Alfa Bank notification has already passed the complete Android delivery path.

Baseline immediately before the second Yandex/T-Bank real test included:

- pending = 0
- last capture = `INSERTED ru.alfabank.mobile.android ...`
- last successful delivery = 2026-09-27T13:48:18.119872Z
- listener lifecycle = connected
- backend observation count = 14, max id = 17
- backend transaction count = 14, max id = 15
- replacement credential `last_used_at` updated at the corresponding successful delivery

This proves the real-device collector, Room, WorkManager, HTTPS transport, authentication, and backend ingestion can work end-to-end. The current issue is narrower than “collector is broken”.

## Real2 test and completed post-test forensics

A controlled real transfer was performed:

- amount: 100 RUB
- source: T-Bank
- destination: Yandex Bank
- both bank apps are installed on the same Samsung device

Evidence log:

`C:\\Users\\Адам\\Documents\\Codex\\bank-collector-real2-20260927-171721.log`

Preserved evidence metadata:

- log size: 5475 bytes
- SHA-256: `37692bc4639520fe3f7f1952bec54fb98ee400a1642c65e4775c57de81f48392`

### Collector/backend result

For both `com.yandex.bank` and `com.idamob.tinkoff.android` during REAL2:

- `CALLBACK_ENTRY`: not found
- capture/insert: not observed
- Room: unchanged
- backend observations: unchanged
- backend transactions: unchanged
- replacement credential `last_used_at`: unchanged
- pending remained 0
- no Android runtime crash was found

Only `ru.yandex.taximeter` was seen in the relevant collector log and was correctly filtered as `not_allowed`.

This placed the REAL2 failure before the collector's bank-specific capture logic.

### T-Bank: concrete system policy blocker found

Package:

- `com.idamob.tinkoff.android`
- Android user: 0
- version observed during forensics: 8.3.0 / 13196

Read-only Android policy inspection found:

- `POST_NOTIFICATIONS=DENIED`
- notification AppOps: `POST_NOTIFICATION=IGNORE`

This is a concrete explanation for why T-Bank produced no NotificationManager record and no collector callback in REAL2.

Treat the T-Bank branch of this test as **policy-blocked**, not as evidence of a collector failure.

Do not continue T-Bank callback debugging unless notification policy is intentionally changed in a separately reviewed/user-approved step and a later test is needed.

### Yandex Bank: Android notification policy looks healthy, post still not proven

Package:

- `com.yandex.bank`
- Android user: 0
- version: 0.241.2 / 11917
- stopped: false
- suspended: false

Read-only policy evidence:

- `POST_NOTIFICATIONS=GRANTED`
- AppOps: default/allow
- app importance: default
- app user-set importance: false
- no package/channel group block was found
- no profile/user boundary was found
- no notification delegation evidence was found
- collector listener remained enabled/live under user 0

Observed Yandex channels included:

- `appmetrica_push`: importance 2, not deleted
- `notification_channel_1`: importance 5, not deleted
- `notification_channel_2`: importance 5, not deleted
- security/sign-in channels: importance 4, not deleted

Push-related components are present, including Firebase Messaging and AppMetrica push components/receivers.

However:

- no Yandex NotificationManager record for the REAL2 event was found
- no current Yandex notification key was found
- no Yandex collector callback was found
- system notification post evidence for the REAL2 event remains absent

Therefore:

- collector callback/capture/Room/backend are not the current Yandex investigation boundary
- Android permission/AppOps/channel policy is not showing a blocker
- the unresolved interval is now specifically:
  remote push delivery -> Firebase/AppMetrica/Yandex push handling -> Yandex application decision/suppression -> Android NotificationManager publication

Do not claim that the Yandex push definitely arrived at the app. That runtime fact has not been proven.

## Latest Yandex Pro live-notification finding

A later live NotificationManager capture materially changed the Yandex diagnosis.

While the notification shade visibly contained six Yandex Pro financial cards (purchases/incoming transfers), a read-only active notification capture found exactly six active records for:

- package: `ru.yandex.taximeter`
- Android user: 0
- channel: `notification_channel_1`
- importance: 4

Active ids included `52091223`.

The preserved REAL2 collector log contains:

- callback package: `ru.yandex.taximeter`
- notification id: `52091223`
- callback wall-clock time: 17:28:11
- result: `FILTERED_NOT_ALLOWED`

The visible shade also contained an incoming-transfer card timestamped 17:28.

The saved live `dumpsys notification` record does not expose `postTime`, so the previously defined strict package+id+postTime join cannot be completed from preserved metadata. For that reason, the formal forensic label remains a strong/partial causal match rather than a mathematically exact two-field join.

Operational interpretation:

- the old assumption that REAL2 should appear as `com.yandex.bank` is no longer the leading hypothesis
- there is strong evidence that the relevant Yandex financial notifications are posted by `ru.yandex.taximeter` / Yandex Pro
- current collector filtering is package-only
- `ru.yandex.taximeter` is not in the configured allowlist
- the callback is therefore rejected before capture/Room/backend
- all six currently observed `ru.yandex.taximeter` active records used `notification_channel_1`
- however, historical exclusivity of that channel to financial notifications is not yet proven

Do not simply add all of `ru.yandex.taximeter` to the allowlist. First establish whether `notification_channel_1` is sufficiently finance-specific. If it is, prefer a backward-compatible package+optional-channel rule while preserving existing package-only behavior for normal bank apps.

The earlier static-analysis branch for `com.yandex.bank` is suspended unless later evidence makes it relevant again.


### Yandex Pro channel-isolation follow-up

Read-only APK analysis of the installed Yandex Pro package used the complete local APK set:

- `base.apk` SHA-256 `d75f5191e1ba887441fb65f084f3090414b344171dbbdb3d1d3186ff2da19278`
- `split_config.arm64_v8a.apk` SHA-256 `f4f8332c43704c355bee19941b1faea7fc651859ce96c7045ecfd57157ae8331`
- `split_config.xxhdpi.apk` SHA-256 `3ab753390bdc0bfa8c02713226bf03ee9e7ba9e74f05f788da8a2ac5d970724d`

Result:

- all six currently visible/active Yandex Pro financial cards used `notification_channel_1`
- no non-financial use of the channel was observed in the captured current set
- historical channel usage was unavailable
- exact static xrefs for `notification_channel_1` were not recovered
- the app uses Flutter/AOT code in `libapp.so`; generic notification-channel APIs were visible but did not prove module exclusivity
- therefore `FINANCIAL_CHANNEL_ISOLATION=NOT_PROVEN`

Do not implement a channel-only allow rule yet. The next useful evidence is a privacy-safe discriminator available on the `StatusBarNotification`/Notification metadata of the six known financial records (for example tag shape/prefix, group, category, creator/intent identity, or another stable non-content field). If no reliable metadata discriminator exists, a deliberately scoped provider-specific content classifier with regression fixtures may be required, but do not introduce brittle regex heuristics without evidence.


### Yandex Pro metadata-discriminator follow-up

Privacy-safe metadata analysis of the six known financial active records found the following common positive-set features:

- package/opPkg: `ru.yandex.taximeter`
- channel: `notification_channel_1`
- importance: 4
- flags: auto-cancel
- visibility: private
- small icon: resource `0x7f110000`
- common group pattern: `0|ru.yandex.taximeter|g:Aggregate_NormalNotificationSection`
- active records had no retained tag value, although the earlier REAL2 callback reported `hasTag=true`

No negative set of known non-financial Yandex Pro notifications was available. Static correlation inside Flutter/AOT code did not prove that channel/icon/group metadata belongs only to financial notifications.

Result:

- `METADATA_DISCRIMINATOR_DECISION=CANDIDATE_ONLY`
- metadata-only filtering is not sufficiently proven for production
- further generic reverse engineering is not justified by the available evidence
- the next design should use a narrow Yandex Pro transport match plus a provider-specific local financial classifier before persistence/backend delivery
- `FINANCIAL` may proceed to mapping/outbox
- `NON_FINANCIAL` and `UNKNOWN` must be dropped locally with safe diagnostics and no raw-content logging
- classifier behavior must be defined from sanitized regression fixtures before implementation


## Samsung Freecess / MARs

Historical diagnostics showed Samsung Freecess/MARs freezing and unfreezing the collector and some Yandex-related background freeze messages.

However, Freecess is **not** a proven root cause.

Do not state that Samsung Freecess caused the missed bank callback unless new evidence directly supports that conclusion.

## Immediate next action

The September 2026 multi-bank evidence campaign is complete for the currently
reviewed providers:

- T-Bank transport E2E is **PROVEN** after notification policy was enabled;
- Sber transport E2E is **PROVEN**;
- Ozon Finance transport E2E is **PROVEN**;
- Alfa transport is historically **PROVEN**, but current parser evidence is insufficient and is **DEFERRED**;
- VTB transport remains **NOT_PROVEN** because no current notification/callback was observed and is **DEFERRED**;
- Yandex normalizer v1 remains **DEPLOYED**.

The sanitized fixture research branch records structural clusters for T-Bank,
Sber, and Ozon. It deliberately does not register runtime parsers because no
cluster proves both event type and direction together with amount, currency, and
event time. Raw notification text, real amounts, names, recipients, account/card
identifiers, and source-event identifiers must remain out of Git.

PR #26 was closed without merge with reason
`ALFA_DETERMINISTIC_FORMAT_NOT_PROVEN`. Its runtime Alfa dispatch must not enter
master until a deterministic format is proven and generic structured normalization
regression coverage is preserved.

The active next step is provider-specific parser implementation only for a future
provider with deterministic sanitized fixtures. Do not start reconciliation,
accounting, or new phone operations in that parser step.

The Yandex real-device transport milestone is closed with an observability gap:

- `ru.yandex.taximeter` -> `notification_channel_1` -> provider-specific financial classifier -> authenticated backend is proven by exact source-event correlation;
- backend observation 18 and transaction 16 were created without manual backend mutation;
- Tinkoff remains separately policy-blocked by notification permission/AppOps;
- persistent `lastCapture` and `lastSuccessfulDelivery` did not reflect the Yandex event and should be investigated separately without another financial operation.

The next roadmap stage is bank-specific parsing and normalization. Keep raw evidence immutable, preserve `UNKNOWN`/`PARTIAL` when notification facts are insufficient, and do not start reconciliation or ledger integration in the same change.

## How to interpret the next evidence

For Yandex static APK forensics:

- if explicit received-push -> no-notification branches exist, record them as candidate suppression paths, not as the REAL2 root cause
- if the relevant push path can be shown to always publish a notification, identify what runtime evidence would be required to distinguish push non-delivery from an unexpected alternate path
- if notification delegation/alternate posting identity exists, document the exact mechanism without changing the collector allowlist yet
- if static analysis is inconclusive, state exactly which code boundary is opaque/obfuscated and design the smallest safe runtime observation needed next

For future collector evidence, the already established stage interpretation remains:

- `CALLBACK_ENTRY -> FILTERED_NOT_ALLOWED`: actual package identity/allowlist issue
- `CALLBACK_ENTRY -> CAPTURE_NULL`: capture conversion issue
- `CAPTURED` without Room insert: Room/duplicate/error issue
- `INSERTED` without backend: WorkManager/network/auth issue; this path has already succeeded for Alfa

## What comes after the current blocker

Once reliable capture/delivery is established for supported banks, the next functional milestone is bank-specific parsing and normalization.

The collector is intentionally RAW_ONLY-oriented today. Future parsers should extract only evidence actually present, such as:

- debit/credit direction
- amount
- currency
- event time
- counterparty/merchant when supported
- controlled account/card reference when supported
- transfer/payment/refund/fee classification when supported

Unknown or partial evidence must remain `UNKNOWN`/`PARTIAL`; do not guess.

Reconciliation with receipts/purchases belongs to a later separate evidence layer.

## Maintenance rule for this file

After a significant completed stage, update this document in a reviewed PR so the next chat begins at the new operational point.

Never commit:

- bearer/device tokens
- DB passwords
- signing private material/passwords
- private keys
- raw sensitive notification payloads
- secret hashes unless a reviewed security design explicitly requires them
