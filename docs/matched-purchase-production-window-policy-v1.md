# Matched-Purchase Production Window Policy v1

## Decision

The production receipt-matching policy is:

`receiptMaxTimeDeltaMs = 300000`

The threshold is an inclusive absolute event-time delta. Exact scope, exact
amount, and exact currency remain mandatory. The matcher continues to build
the complete bipartite compatibility graph and fails closed for ambiguous
components. It does not use nearest-neighbor or greedy selection.

## Evidence

The bounded production sensitivity study covered all 32 eligible Person 1
`PURCHASE / DEBIT` bank rows. The tested receipt thresholds produced 3, 4,
4, 10, 11, and 12 matches at 5, 15, 30, 60, 120, and 300 seconds; the set
remained at 12 through 600, 1800, and 3600 seconds. The 120000 ms threshold
is therefore insufficient: it omits one otherwise isolated compatible pair.

300000 ms is the smallest tested threshold that captures the stable final
production pair set. The 12 final components are isolated one-to-one pairs;
no new compatible edges, ambiguity, or pair identity changes appeared from
300000 through 3600000 ms. The observed pair deltas range from 125 ms to
226847 ms.

The policy is evidence-based and versioned. It may be reviewed when
materially new production evidence changes the observed timing population.
Sber currently has no receipt-compatible pair; that absence is not a reason
to widen the receipt window. Absence of a match remains an acceptable
fail-closed result.

## Separate Internal-Transfer Policy

The internal-transfer time window remains unresolved because production has
no proven internal-transfer pair. The sensitivity study showed that the 32
purchase identities and receipt-compatible edge set were invariant between
5000 ms and 3600000 ms. Accordingly, `internalTransferMaxTimeDeltaMs=5000`
may be used only as a conservative execution parameter for the current
read-only production preview after revalidating that invariance. It is not a
production internal-transfer policy.

This document defines matching-window policy only. It does not authorize the
orchestration writer, deployment, replay, backfill, or any production
mutation.
