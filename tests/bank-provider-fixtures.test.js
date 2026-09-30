import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const providers = [
  ['tbank', 'com.idamob.tinkoff.android'],
  ['sber', 'ru.sberbankmobile'],
  ['ozon', 'ru.ozon.fintech.finance'],
];

const loadFixture = async (name) => JSON.parse(await readFile(
  path.join(root, 'fixtures', 'bank-normalization', name, 'evidence-v1.json'),
  'utf8',
));

const loadSberV2Fixture = async () => JSON.parse(await readFile(
  path.join(root, 'fixtures', 'bank-normalization', 'sber', 'evidence-v2.json'),
  'utf8',
));

const loadSberV3Fixture = async () => JSON.parse(await readFile(
  path.join(root, 'fixtures', 'bank-normalization', 'sber', 'evidence-v3.json'),
  'utf8',
));

test('real-derived bank fixtures are sanitized, provider-scoped, and fail closed', async () => {
  for (const [name, provider] of providers) {
    const fixture = await loadFixture(name);
    assert.equal(fixture.provider, provider);
    assert.equal(fixture.source, 'real-derived-sanitized');
    assert.ok(fixture.clusters.length > 0);
    if (name === 'sber') assert.ok(fixture.clusters.some((cluster) => cluster.readyCapable === true));
    else assert.ok(fixture.clusters.every((cluster) => cluster.readyCapable === false));
    assert.ok(fixture.clusters.filter((cluster) => cluster.readyCapable === false).every((cluster) => cluster.evidence.eventType === 'NOT_PROVEN'));
    assert.ok(fixture.clusters.filter((cluster) => cluster.readyCapable === false).every((cluster) => cluster.evidence.direction === 'NOT_PROVEN'));
    assert.equal(fixture.acceptance.dedup, 'EXISTING_CONTRACT_UNCHANGED');
    assert.equal(fixture.acceptance.sourceEventIdConflict, 'EXISTING_CONTRACT_UNCHANGED');
  }
});

test('sanitized fixtures contain no production provider payload identifiers', async () => {
  for (const [name] of providers) {
    const versions = name === 'sber' ? ['evidence-v1.json', 'evidence-v2.json', 'evidence-v3.json'] : ['evidence-v1.json'];
    for (const version of versions) {
      const text = await readFile(path.join(root, 'fixtures', 'bank-normalization', name, version), 'utf8');
      assert.doesNotMatch(text, /"sourceEventId"|"payloadSha|real card|real account/i);
      assert.doesNotMatch(text, /Т-Банк|Сбербанк|Озон|Альфа|Яндекс/i);
    }
  }
});

test('Sber v2 fixture records the exact checkmark envelope separately', async () => {
  const fixture = await loadSberV2Fixture();
  const checkmark = fixture.clusters.find((cluster) => cluster.id === 'sber-incoming-transfer-v2-checkmark');
  const referenceOnly = fixture.clusters.find((cluster) => cluster.id === 'sber-reference-only');
  assert.equal(fixture.provider, 'ru.sberbankmobile');
  assert.equal(fixture.normalizationVersion, 'sber-bank-normalizer-v2');
  assert.equal(checkmark.readyCapable, true);
  assert.equal(checkmark.observationCount, 1);
  assert.equal(checkmark.syntheticPayload.title, '✅ Поступление от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ');
  assert.equal(referenceOnly.readyCapable, false);
});

test('Sber v3 fixture records only the current canonical envelope', async () => {
  const fixture = await loadSberV3Fixture();
  const current = fixture.clusters.find((cluster) => cluster.id === 'sber-incoming-transfer-v3-current');
  assert.equal(fixture.provider, 'ru.sberbankmobile');
  assert.equal(fixture.normalizationVersion, 'sber-bank-normalizer-v3');
  assert.equal(fixture.controlledIncomingObservationCount, 2);
  assert.equal(current.observationCount, 2);
  assert.equal(current.readyCapable, true);
  assert.match(current.titleEnvelope, /^Перевод по СБП от <sender>\.$/u);
  assert.match(current.bodyEnvelope, /Баланс:/u);
});
