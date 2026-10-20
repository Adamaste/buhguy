import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePrepaidWalletBalance,
  confirmPrepaidWalletTopup,
  TROIKA_PREPAID_WALLET_ENABLED_ENV,
} from '../src/prepaid-wallet.js';

test('wallet balance is a snapshot plus later movements, not the sum of historical topups', () => {
  const result = calculatePrepaidWalletBalance({ id: 4, balance: '20.00', observedAt: '2026-10-19T12:00:00.000Z' }, [
    { movementType: 'TOPUP', amount: '21.00', occurredAt: '2026-10-19T12:01:00.000Z' },
    { movementType: 'TOPUP', amount: '34.00', occurredAt: '2026-10-19T12:02:00.000Z' },
    { movementType: 'RIDE_REDEMPTION', amount: '12.00', occurredAt: '2026-10-19T12:03:00.000Z' },
  ], '2026-10-19T12:04:00.000Z');
  assert.deepEqual(result, { status: 'KNOWN', balance: '63.00', snapshotId: 4 });
});

test('balance fails closed without a baseline or when the snapshot boundary is ambiguous', () => {
  assert.equal(calculatePrepaidWalletBalance(null, [], '2026-10-20T00:00:00.000Z').status, 'BASELINE_REQUIRED');
  assert.equal(calculatePrepaidWalletBalance(
    { id: 1, balance: '10.00', observedAt: '2026-10-20T00:00:00.000Z' },
    [{ movementType: 'TOPUP', amount: '1.00', occurredAt: '2026-10-20T00:00:00.000Z' }],
    '2026-10-20T00:00:01.000Z',
  ).status, 'AMBIGUOUS_SNAPSHOT_BOUNDARY');
  assert.equal(calculatePrepaidWalletBalance(
    { id: 1, balance: '10.00', observedAt: '2026-10-20T00:00:00.000Z' },
    [{ movementType: 'RIDE_REDEMPTION', amount: '11.00', occurredAt: '2026-10-20T00:00:01.000Z' }],
    '2026-10-20T00:00:02.000Z',
  ).status, 'INSUFFICIENT_BALANCE');
});

test('manual wallet writes fail closed unless the dedicated feature flag is true', async () => {
  const previous = process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV];
  delete process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV];
  try {
    await assert.rejects(
      confirmPrepaidWalletTopup({}, { walletId: 1 }),
      (error) => error.code === 'TROIKA_WALLET_WRITES_DISABLED',
    );
  } finally {
    if (previous === undefined) delete process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV];
    else process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV] = previous;
  }
});
