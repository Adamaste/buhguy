import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const providers = [
  ['alfa', 'ru.alfabank.mobile.android'],
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

const loadSberV4Fixture = async () => JSON.parse(await readFile(
  path.join(root, 'fixtures', 'bank-normalization', 'sber', 'evidence-v4.json'),
  'utf8',
));

const loadAlfaV2Fixture = async () => JSON.parse(await readFile(
  path.join(root, 'fixtures', 'bank-normalization', 'alfa', 'evidence-v2.json'),
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
    const versions = name === 'sber' ? ['evidence-v1.json', 'evidence-v2.json', 'evidence-v3.json', 'evidence-v4.json'] : ['evidence-v1.json'];
    const fixtureVersions = name === 'alfa' ? [...versions, 'evidence-v2.json'] : versions;
    for (const version of fixtureVersions) {
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

test('Sber v4 fixture records the proven outgoing-shaped partial envelope', async () => {
  const fixture = await loadSberV4Fixture();
  const outgoing = fixture.clusters.find((cluster) => cluster.id === 'sber-outgoing-partial-v4');
  const companion = fixture.clusters.find((cluster) => cluster.id === 'sber-outgoing-reference-only');
  assert.equal(fixture.provider, 'ru.sberbankmobile');
  assert.equal(fixture.normalizationVersion, 'sber-bank-normalizer-v4');
  assert.equal(fixture.controlledOutgoingIndependentSampleCount, 3);
  assert.equal(fixture.controlledOutgoingPrimaryObservationCount, 4);
  assert.equal(fixture.controlledOutgoingCompanionObservationCount, 4);
  assert.equal(outgoing.observationCount, 4);
  assert.equal(outgoing.readyCapable, false);
  assert.equal(outgoing.evidence.eventType, 'UNKNOWN');
  assert.equal(outgoing.evidence.direction, 'UNKNOWN');
  assert.equal(outgoing.evidence.normalizationStatus, 'PARTIAL');
  assert.equal(companion.readyCapable, false);
  assert.equal(companion.observationCount, 4);
});

test('T-Bank fixture records only the proven top-up partial envelope', async () => {
  const fixture = await loadFixture('tbank');
  const topUp = fixture.clusters.find((cluster) => cluster.id === 'tbank-top-up-partial-v1');
  assert.equal(fixture.controlledTopUpIndependentSampleCount, 2);
  assert.equal(topUp.observationCount, 2);
  assert.equal(topUp.readyCapable, false);
  assert.equal(topUp.evidence.amountGrammar, 'integer RUB position before Доступно');
  assert.equal(topUp.evidence.currencyGrammar, 'RUB marker present');
  assert.equal(topUp.evidence.eventTime, 'ANDROID_ENVELOPE_PROVEN');
  assert.equal(topUp.evidence.eventType, 'NOT_PROVEN');
  assert.equal(topUp.evidence.direction, 'NOT_PROVEN');
  assert.equal(topUp.evidence.accountReferenceStructure, 'NOT_PROVEN');
});

test('Alfa fixture records only the proven F5 partial envelope', async () => {
  const fixture = await loadFixture('alfa');
  const f5 = fixture.clusters.find((cluster) => cluster.id === 'alfa-f5-transfer-partial');
  assert.equal(fixture.provider, 'ru.alfabank.mobile.android');
  assert.equal(fixture.corpusObservationCount, 19);
  assert.equal(fixture.structuralFamilyCount, 11);
  assert.equal(fixture.controlledF5IndependentSampleCount, 2);
  assert.equal(f5.observationCount, 4);
  assert.equal(f5.readyCapable, false);
  assert.equal(f5.evidence.direction, 'NOT_PROVEN');
  assert.match(f5.evidence.amountGrammar, /integer RUB title/);
});

test('Alfa v2 fixture records the fresh comma-decimal title variant', async () => {
  const fixture = await loadAlfaV2Fixture();
  const f5 = fixture.clusters.find((cluster) => cluster.id === 'alfa-f5-transfer-partial-v2');
  const companion = fixture.clusters.find((cluster) => cluster.id === 'alfa-empty-or-companion');
  assert.equal(fixture.provider, 'ru.alfabank.mobile.android');
  assert.equal(fixture.normalizationVersion, 'alfa-bank-normalizer-v2');
  assert.equal(fixture.corpusObservationCount, 22);
  assert.equal(fixture.structuralFamilyCount, 11);
  assert.equal(fixture.controlledF5IndependentSampleCount, 3);
  assert.equal(f5.observationCount, 5);
  assert.equal(f5.controlledObservationCount, 3);
  assert.deepEqual(f5.fields.title.variants, [
    'minus integer RUB symbol',
    'minus comma-decimal(two digits) RUB symbol',
  ]);
  assert.equal(f5.readyCapable, false);
  assert.equal(companion.observationCount, 4);
});
