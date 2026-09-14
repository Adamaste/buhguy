import { Pool } from 'pg';
import { dryRunReturnRefundMatches } from '../src/return-refund-matcher.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const result = await dryRunReturnRefundMatches(pool, { scopeKey: process.env.RETURN_SCOPE_KEY ?? 'default' });
const statuses = Object.fromEntries(['CONFIRMED', 'AMBIGUOUS', 'CANDIDATE_ONLY', 'UNMATCHED']
  .map((status) => [status, result.results.filter((row) => row.status === status).length]));
const exposure = (status) => result.results.filter((row) => row.status === status).reduce((total, row) => ({
  fiscalFaceValue: total.fiscalFaceValue + Number(row.returnReceipt.totalSum ?? 0),
  newMoney: total.newMoney + Number(row.returnReceipt.cashTotalSum ?? 0) + Number(row.returnReceipt.ecashTotalSum ?? 0),
  prepaid: total.prepaid + Number(row.returnReceipt.prepaidSum ?? 0),
}), { fiscalFaceValue: 0, newMoney: 0, prepaid: 0 });
const output = {
  rule: result.rule,
  matcherVersion: result.matcherVersion,
  summary: result.summary,
  statuses,
  exposure: Object.fromEntries(['CONFIRMED', 'AMBIGUOUS', 'CANDIDATE_ONLY', 'UNMATCHED'].map((status) => [status, exposure(status)])),
  confirmedCandidateIds: result.results.filter((row) => row.status === 'CONFIRMED').map((row) => row.returnReceiptId),
  confirmedPurchaseTargets: result.results.filter((row) => row.status === 'CONFIRMED').map((row) => row.purchaseTarget),
  refundEvents: result.results.filter((row) => row.refundStatus === 'PROVEN').length,
};
console.log(JSON.stringify(output, null, 2));
await pool.end();
