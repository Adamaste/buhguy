# Accounting Model (Audit Proposal)

This is a design artifact only. It is not a production schema change.

## Source-of-truth hierarchy

1. Immutable FNS response and source metadata.
2. Parsed fiscal document and fiscal items, retaining parser version and content hash.
3. Explicit business-event graph: purchase, payment, fulfillment, return, cancellation, correction, advance and credit.
4. Double-entry accounting postings generated from approved rules.
5. Certified analytics projections.

`receipt` is not `purchase`; `receipt.total_sum` is not automatically cash outflow; `purchase` is not `payment`.

## Proposed evidence model

Each source observation needs `source_type`, scoped external ID, received timestamp, event timestamp, raw reference, parser version, content hash, and ingestion attempt status. Raw evidence is append-only. A new parser version creates a new interpretation, not a mutation of historical evidence.

## Event graph

Use N-to-N links with allocation amounts and confidence, rather than a single receipt pair. A fiscal event can link to one or more purchase/payment/fulfillment events; an event can be evidenced by multiple fiscal documents. Every allocation must be explainable and sum-constrained.

## Ledger sketch

Useful accounts include cash, electronic cash, advance-to-merchant, inventory/service expense, payable/credit, refunds, and unresolved suspense. Postings should be generated only from evidence and approved rules. For a prepayment followed by settlement: first post cash decrease and advance increase; later post advance decrease and purchase/fulfillment recognition, with zero new cash when the evidence says so. Returns reverse the appropriate recognized amount, not an arbitrary receipt total.

## Invariants

See `docs/accounting-invariants.md`. The central requirement is that an incremental run and a full rebuild produce the same event graph, allocations, postings, reconciliation and unresolved queue.

## Current audit conclusion

The existing tables are a sound evidence/normalized receipt POC, but not an accounting-grade core. The missing event graph and ledger make automatic spend reporting unsafe when advances, settlement, returns, mixed item payments or corrections exist.
