# Alfa Lifecycle Canonicalization v1

This document describes a standalone, non-mutating post-ingestion projection.
It does not change `bank_transactions`, rewrite history, or authorize
production wiring.

## Evidence Boundary

The projection recognizes only the reviewed Alfa lifecycle shape:

1. one exact primary purchase-shaped observation;
2. one later minus-bearing update with the same proven monetary amount and
   the exact observed title/body structural shape;
3. one immediately following empty companion.

The primary is the only canonical monetary member. The update is direction
evidence only. The empty companion is non-monetary. The projection emits one
candidate only when the full lifecycle match is unique; zero or multiple
matches remain `UNRESOLVED` with a reason code.

The candidate intentionally has:

- `eventType=UNKNOWN`;
- `direction=DEBIT`;
- exact decimal-string amount from the primary;
- `currency=RUB`;
- primary envelope event time as `occurredAt`;
- `READY` / `EXACT` evidence status;
- null merchant, counterparty, account reference, and reference kind.

`UNKNOWN` is deliberate. The primary grammar is disjoint from the exact Alfa
F5 transfer grammar, but the same primary shape has a natural observation
without purchase ground truth. This v1 projection therefore does not infer
`PURCHASE`.

## Correlation Rule

Matching requires the same provider, non-empty source package, available
notification channel, exact primary/update/empty structural members,
primary-before-update ordering, exact primary/update amount equality, and a
unique companion. Every lifecycle member must carry a valid Android envelope
`eventTime`; the canonical `occurredAt` is taken from the primary event time,
not from a fallback capture timestamp. If the channel is present, it must
agree across members; an absent channel is not invented.

The update member is matched only in the reviewed shape: title `- <integer> ₽. <word>`, body `<word>: <comma-decimal> ₽; <masked-suffix>`, with equal description and text. Its body monetary token is structural update evidence and is not promoted as an independent transaction amount; only exact equality with the primary amount is accepted.

The timing bounds are evidence-derived from the three reviewed Alfa
topologies: primary to update is 10-12 seconds by envelope event time, and
update to empty companion is 0-0.5 seconds. These bounds are not used alone as
identity. If multiple primaries compete for one update, multiple updates fit
one primary, amounts disagree, order is reversed, or a required member is
missing, the cluster fails closed.

The output contains only structural provenance: primary, update, and
companion observation/transaction ids, model/rule versions, member roles, and
reason/status. It does not expose raw payload, source event ids, or secrets.
The projection key is a deterministic content-sensitive fingerprint of the
model, rule, member identities, amount, time, and semantic fields.

## Boundaries

The existing `alfa-bank-normalizer-v4` exclusively owns the exact F5 outgoing
transfer grammar, including its complete title, four-section body, account,
transfer, recipient, trailing, amount-equality, and event-time checks. This
projection must not reinterpret F5 notifications or promote an update/empty
companion as another monetary movement. A title amount alone is not F5
evidence.

The projection is suitable for in-memory adaptation to the existing cash-flow
and balanced-journal projections. It may produce an unclassified outgoing
money movement with `UNRESOLVED_BANK_ACCOUNT` only when an explicit,
evidence-backed source scope is supplied; it does not fabricate a default
scope. Without that scope, downstream projection remains unresolved. It does
not persist cash flow, journals, business events, ledger entries,
reconciliation results, or internal transfers. No account ownership is
inferred.

Future cash-withdrawal, fee, purchase, or other Alfa families require their
own evidence-backed rules. They must fail closed until separately proven.
