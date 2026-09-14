# Regression Matrix

The production implementation must execute these cases against fixtures and replay tests. `P` means positive, `N` counterexample, `R` replay/idempotency, `U` unresolved/exception behavior.

| # | Case | Expected |
|---:|---|---|
| 1 | direct purchase, cash | one cash posting |
| 2 | direct purchase, e-cash | one electronic cash posting |
| 3 | prepayment then settlement | no double cash |
| 4 | settlement before fulfillment evidence | unresolved allocation |
| 5 | many receipts to one purchase | many-to-one allocation |
| 6 | one purchase to many receipts | one-to-many allocation |
| 7 | same amount, different goods | not merged |
| 8 | repeated identical purchase | not merged |
| 9 | merchant ID exact match | candidate/approved by scope |
| 10 | merchant ID collision | unresolved |
| 11 | merchant ID reuse | unresolved or scoped |
| 12 | split delivery | one purchase, multiple fulfillment events |
| 13 | partial fulfillment | partial recognition |
| 14 | full return | reverse recognized value |
| 15 | partial return | bounded reversal |
| 16 | return without original | unresolved |
| 17 | cancellation before payment | no cash reversal |
| 18 | cancellation after payment | refund/advance workflow |
| 19 | gift certificate purchase | stored-value liability |
| 20 | gift certificate redemption | liability decrease, not new spend |
| 21 | cashback | separate benefit/adjustment policy |
| 22 | credit sale | payable/credit balance |
| 23 | credit settlement | no duplicate purchase |
| 24 | mixed item payment types | item-level split |
| 25 | operation type 1 | receipt semantics only |
| 26 | operation type 2 | return semantics only |
| 27 | operation type 3 | expense semantics explicit |
| 28 | operation type 4 | expense return explicit |
| 29 | missing optional field | missing, not zero |
| 30 | invalid operation type | NULL/unresolved, ingest continues |
| 31 | FFD 1.05/old | supported-field policy |
| 32 | newer FFD | unsupported-field policy |
| 33 | zero component | explicit zero |
| 34 | missing component | distinct missing state |
| 35 | correction document | versioned correction |
| 36 | correction after close | restatement, no silent mutation |
| 37 | late receipt | event time vs received time |
| 38 | out-of-order settlement | deterministic later rebuild |
| 39 | timezone boundary | explicit local/UTC policy |
| 40 | duplicate source delivery | idempotent |
| 41 | concurrent same receipt | one canonical evidence link |
| 42 | retry after DB failure | atomic retry |
| 43 | retry after partial network | no duplicate posting |
| 44 | full rebuild | equals incremental |
| 45 | parser version change | old interpretation retained |
| 46 | seller label change | identity uses stable scoped keys |
| 47 | provider absent | no false provider join |
| 48 | product code absent | name not treated as stable ID |
| 49 | same product across sellers | seller scope retained |
| 50 | same market ID across users | no cross-user merge |
| 51 | refund after month close | controlled restatement |
| 52 | FX/foreign currency | currency/rounding policy |
| 53 | high-value ambiguous case | blocks certification |
| 54 | zero-value receipt | explicit policy |
| 55 | negative/invalid quantity | reject or unresolved |
| 56 | item sum rounding | bounded residual policy |
| 57 | item sum differs from total | reconciliation exception |
| 58 | raw missing | cannot certify normalized row |
| 59 | raw hash changed | new evidence version |
| 60 | source account isolation | no cross-account joins |
| 61 | ownership change | explicit ownership event |
| 62 | backup/restore replay | same graph and ledger |
| 63 | authentication outage | failed run, no false empty success |

The current POC has tests for normalization, operation type and receipt replay, but not this accounting matrix.
