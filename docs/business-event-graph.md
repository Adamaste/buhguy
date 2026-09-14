# Phase 2A Business Event Graph

## Scope

This is a model foundation only. Migration `005_business_event_graph.sql` creates graph metadata and relational tables but does not backfill receipts, run a matcher, create purchases, or post financial totals. A fiscal receipt remains evidence; it is not implicitly a purchase, payment, fulfillment, return, refund, or cash movement.

The graph deliberately keeps these concepts distinct: `PURCHASE`, `PAYMENT`, `PREPAYMENT`, `ADVANCE`, `FULFILLMENT`, `RETURN`, and `REFUND`. The catalog is extensible for credit, stored value, transfers, fees, interest, corrections, and other future events. `operation_type` and item `paymentType` remain source facts; neither alone creates a business event.

## Relational model

- `accounting_scopes` isolates household/accounting ownership boundaries.
- `business_event_types` and `business_event_relations` are catalogs. Required directed relations are `PAYMENT_FOR`, `PREPAYMENT_FOR`, `FULFILLS`, `RETURNS`, `REFUNDS`, and `SETTLES`.
- `business_graph_rules` registers the rule code and version used by every assertion; `business_graph_runs` is reserved for run-level provenance.
- `business_events` stores an event concept, resolution status (`CANDIDATE`, `CONFIRMED`, `AMBIGUOUS`, `REJECTED`, `SUPERSEDED`), origin (`SYSTEM_DERIVED`, `MANUAL`, `EXTERNAL_CONFIRMED`), model/rule provenance, and a deterministic semantic key.
- `business_event_evidence` links an event to an exact receipt or item fiscal fact and its `normalization_version`. Multiple evidence rows are allowed, so one event can have many-to-many evidence.
- `business_event_edges` stores typed source-to-target relations. For example, `PREPAYMENT --PREPAYMENT_FOR--> PURCHASE` and `FULFILLMENT --FULFILLS--> PURCHASE`. Database composite foreign keys prevent cross-scope edges and self-edges.
- `business_event_allocations` records partial quantity and/or amount allocations to receipt or item facts. Candidate allocations may overlap. The validator bounds confirmed allocations but does not reject candidate alternatives.

The normalized-fact foreign keys are composite `(id, normalization_version)`, so evidence cannot silently refer to a different normalization version. Source `receipts`, `receipt_items`, and `receipt_raw` are not modified by this phase.

## Provenance and lifecycle

Every event, evidence link, edge, and allocation requires `graph_model_version`, `rule_code`, `rule_version`, `origin`, and resolution status where applicable. Semantic keys are deterministic and protected by database uniqueness barriers; generated timestamps are not part of identity. `ON CONFLICT` replay is therefore idempotent, including concurrent creation of the same assertion.

`rebuildSystemDerived()` removes only `SYSTEM_DERIVED` graph rows for the selected scope/model/rule. Manual and external assertions survive. Mutations can be grouped in `withTransaction()` so a failed graph build rolls back atomically.

## Validation and CLI

`validateBusinessEventGraph(pool)` checks dangling links, duplicate semantic keys, missing provenance, cross-scope/self edges, negative allocations, and confirmed receipt/item over-allocation. `receipt-collector graph validate` emits the result; `receipt-collector graph inspect <id>` emits one event and its graph links without raw/auth data. These commands must be run only against a database where migration 005 is intentionally present; this phase does not run them against production.

## Acceptance boundaries

The Xiaomi fixture is disposable-test data only: two separate fiscal documents with the same `32380 RUB` business amount, one explicit prepayment and one explicit fulfillment linked to a manually asserted purchase. Identical-looking purchases remain separate, ambiguous alternatives coexist, partial returns are representable, and a service item with unresolved identity remains evidence rather than an invented service match. No historical receipts are auto-matched and no ledger, purchase table, or accounting total is created.
