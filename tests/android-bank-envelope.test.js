import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBankEventInput } from '../src/bank-ingestion.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Android V1 fixture matches the existing bank ingestion envelope contract', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'android/fixtures/bank-envelope.json'), 'utf8'));
  const validated = validateBankEventInput(fixture);
  assert.match(validated.sourceEventId, /^[a-f0-9]{64}$/);
  assert.equal(validated.ingestionMetadata.adapter, 'android-notification');
  assert.deepEqual(Object.keys(validated.payload).sort(), ['text', 'title']);
});
