import test from 'node:test';
import assert from 'node:assert/strict';
import { runBankAccountCommand } from '../src/cli.js';
import { HISTORICAL_REPLAY_PROVENANCE } from '../src/bank-account-resolution.js';

test('historical replay has explicit provenance and defaults to observation input', async () => {
  assert.equal(HISTORICAL_REPLAY_PROVENANCE, 'HISTORICAL_OBSERVATION_REPLAY');
  await assert.rejects(
    () => runBankAccountCommand({ _: ['resolve-historical'], 'account-id': '1', 'observation-id': '72' }, { pool: {} }),
    /does not accept --account-id/,
  );
  await assert.rejects(
    () => runBankAccountCommand({ _: ['resolve-historical'] }, { pool: {} }),
    /requires --observation-id/,
  );
});
