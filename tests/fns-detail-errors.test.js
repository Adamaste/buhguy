import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { detailErrorSignature, isKnownFnsDetailUnavailable, safeDetailErrorFields } from '../src/fns-detail-errors.js';

const knownCode = 'receipt-not-found';
const knownPrefix = crypto.createHash('sha256').update(knownCode).digest('hex').slice(0, 16);

test('known FNS detail error requires status, code and provider message', () => {
  const error = { status: 422, code: knownCode, message: 'Сервис получения чеков временно недоступен' };
  assert.doesNotThrow(() => safeDetailErrorFields(error));
  assert.equal(typeof detailErrorSignature(error), 'string');
  assert.equal(isKnownFnsDetailUnavailable(error, { codeSha256Prefix: knownPrefix }), true);
  assert.equal(isKnownFnsDetailUnavailable({ ...error, status: 500 }, { codeSha256Prefix: knownPrefix }), false);
  assert.equal(isKnownFnsDetailUnavailable({ status: 422, code: knownCode, message: 'other' }, { codeSha256Prefix: knownPrefix }), false);
});

test('detail error fields keep only bounded diagnostic values', () => {
  const fields = safeDetailErrorFields({ status: 422, code: 'x'.repeat(300), message: 'unavailable' });
  assert.equal(fields.httpStatus, 422);
  assert.equal(fields.errorCode.length, 128);
  assert.match(fields.errorSignature, /^[a-f0-9]{64}$/);
});
