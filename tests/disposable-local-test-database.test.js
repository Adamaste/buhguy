import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';

test('destructive integration database guard accepts only localhost disposable databases', () => {
  assert.equal(assertDisposableLocalTestDatabase('postgres://tester:local@127.0.0.1:5432/finance_receipt_collector_test_unit_1'), 'finance_receipt_collector_test_unit_1');
  assert.equal(assertDisposableLocalTestDatabase('postgresql://tester:local@[::1]:5432/finance_receipt_collector_test_unit_2'), 'finance_receipt_collector_test_unit_2');
  assert.throws(() => assertDisposableLocalTestDatabase('postgres://tester:secret@production.example/finance_receipt_collector_test_prod'), /localhost/);
  assert.throws(() => assertDisposableLocalTestDatabase('postgres://tester:local@localhost/finance_receipt_collector_test_prod?host=production.example'), /override/);
  assert.throws(() => assertDisposableLocalTestDatabase('postgres://tester:local@localhost/production'), /disposable/);
  assert.throws(() => assertDisposableLocalTestDatabase('mysql://tester:local@localhost/finance_receipt_collector_test_local'), /PostgreSQL/);
});
