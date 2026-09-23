import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { normalizeOperationType } from './normalize.js';
import { decodePostgresJsonEvidence } from './postgres-json-evidence.js';

export const NORMALIZATION_VERSION = 'fiscal-normalizer-v1';
const FFD_VERSIONS = new Map([['2', '1.05'], ['3', '1.1'], ['4', '1.2']]);
const PAYMENT_TYPES = new Map([[1, 'PREPAYMENT_100'], [2, 'PREPAYMENT'], [3, 'ADVANCE'], [4, 'FULL_SETTLEMENT'], [5, 'PARTIAL_SETTLEMENT_AND_CREDIT'], [6, 'CREDIT_TRANSFER'], [7, 'CREDIT_PAYMENT']]);
const COMPONENTS = [['cashTotalSum', 'cash_total_sum', 'cash_total_state'], ['ecashTotalSum', 'ecash_total_sum', 'ecash_total_state'], ['prepaidSum', 'prepaid_sum', 'prepaid_state'], ['creditSum', 'credit_sum', 'credit_state'], ['provisionSum', 'provision_sum', 'provision_state']];

function decimal(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function cents(value) {
  const normalized = decimal(value);
  if (normalized === null) return null;
  const negative = normalized.startsWith('-');
  const text = negative ? normalized.slice(1) : normalized;
  const [whole, fraction] = text.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -amount : amount;
}

function component(raw, key, ffdKnown) {
  if (!ffdKnown) return { value: null, state: 'FIELD_NOT_SUPPORTED' };
  if (!raw || typeof raw !== 'object') return { value: null, state: 'FIELD_MISSING' };
  if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined || raw[key] === null) return { value: null, state: 'FIELD_MISSING' };
  const value = decimal(raw[key]);
  return value === null ? { value: null, state: 'FIELD_INVALID' } : { value, state: value === '0.00' ? 'EXPLICIT_ZERO' : 'PRESENT_VALUE' };
}

function paymentStage(codes) {
  const set = new Set(codes);
  if (set.size === 0) return 'UNKNOWN';
  if ([...set].every((code) => code === 1 || code === 2)) return 'PREPAYMENT_ONLY';
  if ([...set].every((code) => code === 3)) return 'ADVANCE_ONLY';
  if ([...set].every((code) => code === 4 || code === 5)) return 'SETTLEMENT_ONLY';
  if ([...set].every((code) => code === 6 || code === 7)) return 'CREDIT_ONLY';
  return 'MIXED';
}

export function normalizeFiscalEvidence(raw, { receiptId, sourceItems = [] } = {}) {
  const ffdVersionCode = raw?.fiscalDocumentFormatVer === undefined || raw?.fiscalDocumentFormatVer === null ? null : String(raw.fiscalDocumentFormatVer);
  const ffdVersion = FFD_VERSIONS.get(ffdVersionCode) ?? null;
  const issues = [];
  if (!ffdVersion) issues.push({ issueCode: 'UNKNOWN_FFD_VERSION', details: { path: '$.fiscalDocumentFormatVer', valuePresent: ffdVersionCode !== null } });
  const facts = { receiptId, normalizationVersion: NORMALIZATION_VERSION, ffdVersionCode, ffdVersion, fiscalOperationType: normalizeOperationType(raw?.operationType), householdCashDirection: null, paymentComponentsStatus: null, paymentStage: 'UNKNOWN', correctionStatus: ffdVersion ? (raw?.correction && typeof raw.correction === 'object' ? 'CORRECTION' : 'UNKNOWN') : 'UNSUPPORTED' };
  if (facts.fiscalOperationType !== null) facts.householdCashDirection = [1, 4].includes(facts.fiscalOperationType) ? 'OUT' : 'IN';
  else issues.push({ issueCode: 'INVALID_OPERATION_TYPE', details: { path: '$.operationType' } });

  const componentValues = {};
  for (const [rawKey, valueKey, stateKey] of COMPONENTS) {
    const value = component(raw, rawKey, Boolean(ffdVersion));
    facts[valueKey] = value.value;
    facts[stateKey] = value.state;
    componentValues[rawKey] = value;
    if (value.state === 'FIELD_INVALID') issues.push({ issueCode: 'INVALID_PAYMENT_COMPONENT', details: { path: `$.${rawKey}` } });
  }
  const states = COMPONENTS.map(([, , stateKey]) => facts[stateKey]);
  if (!ffdVersion) facts.paymentComponentsStatus = 'UNSUPPORTED';
  else if (states.includes('FIELD_MISSING') || states.includes('FIELD_INVALID')) facts.paymentComponentsStatus = 'INCOMPLETE';
  else {
    const total = cents(raw?.totalSum);
    const sum = COMPONENTS.reduce((totalSum, [rawKey]) => totalSum + (cents(componentValues[rawKey].value) ?? 0n), 0n);
    facts.paymentComponentsStatus = total === null ? 'INCOMPLETE' : (total === sum ? 'RECONCILED' : 'MISMATCH');
    if (facts.paymentComponentsStatus === 'MISMATCH') issues.push({ issueCode: 'PAYMENT_COMPONENT_MISMATCH', details: { path: '$.totalSum' } });
  }

  const itemFacts = [];
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const codes = [];
  items.forEach((item, position) => {
    const paymentType = Number.isInteger(item?.paymentType) ? item.paymentType : (typeof item?.paymentType === 'string' && /^[1-7]$/.test(item.paymentType) ? Number(item.paymentType) : null);
    if (paymentType !== null) codes.push(paymentType);
    if (paymentType === null || !PAYMENT_TYPES.has(paymentType)) issues.push({ issueCode: 'INVALID_PAYMENT_TYPE', receiptItemId: sourceItems[position]?.id ?? null, details: { path: `$.items[${position}].paymentType` } });
    const productType = item?.productType === undefined || item?.productType === null ? null : Number(item.productType);
    if (item?.productType !== undefined && (!Number.isInteger(productType) || productType < 0)) issues.push({ issueCode: 'INVALID_PRODUCT_TYPE', receiptItemId: sourceItems[position]?.id ?? null, details: { path: `$.items[${position}].productType` } });
    itemFacts.push({ receiptItemId: sourceItems[position]?.id ?? null, paymentTypeCode: PAYMENT_TYPES.has(paymentType) ? paymentType : null, paymentTypeSemantic: PAYMENT_TYPES.get(paymentType) ?? null, productTypeCode: Number.isInteger(productType) && productType >= 0 ? productType : null, providerInn: item?.providerInn ?? null, gtin: item?.productCodeNew?.code?.gtin ?? null, rawProductCode: item?.productCodeNew?.code?.rawProductCode ?? null });
  });
  facts.paymentStage = paymentStage(codes);
  if (facts.paymentComponentsStatus === 'UNSUPPORTED' || !ffdVersion) facts.normalizationStatus = 'UNSUPPORTED';
  else if (issues.length || facts.paymentComponentsStatus !== 'RECONCILED') facts.normalizationStatus = 'BLOCKED';
  else facts.normalizationStatus = 'READY';
  const semantic = { ...facts, itemFacts, issues };
  facts.sourceContentSha256 = fiscalContentFingerprint(raw);
  facts.normalizedContentSha256 = fiscalContentFingerprint(semantic);
  return { facts, itemFacts, issues, semantic };
}

export async function normalizeAndStoreReceipt(pool, receiptId, normalizationVersion = NORMALIZATION_VERSION) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rawResult = await client.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1 FOR UPDATE', [receiptId]);
    const itemResult = await client.query('SELECT id, position FROM receipt_items WHERE receipt_id=$1 ORDER BY position', [receiptId]);
    if (!rawResult.rowCount) throw new Error('Source receipt_raw evidence is missing');
    const raw = decodePostgresJsonEvidence(rawResult.rows[0].payload);
    const result = normalizeFiscalEvidence(raw, { receiptId, sourceItems: itemResult.rows });
    if (result.facts.normalizationVersion !== normalizationVersion) throw new Error('Unsupported normalization version');
    await client.query(`INSERT INTO receipt_fiscal_facts (receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,ffd_version_code,ffd_version,fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (receipt_id,normalization_version) DO UPDATE SET source_content_sha256=EXCLUDED.source_content_sha256,normalized_content_sha256=EXCLUDED.normalized_content_sha256,normalization_status=EXCLUDED.normalization_status,ffd_version_code=EXCLUDED.ffd_version_code,ffd_version=EXCLUDED.ffd_version,fiscal_operation_type=EXCLUDED.fiscal_operation_type,household_cash_direction=EXCLUDED.household_cash_direction,cash_total_sum=EXCLUDED.cash_total_sum,cash_total_state=EXCLUDED.cash_total_state,ecash_total_sum=EXCLUDED.ecash_total_sum,ecash_total_state=EXCLUDED.ecash_total_state,prepaid_sum=EXCLUDED.prepaid_sum,prepaid_state=EXCLUDED.prepaid_state,credit_sum=EXCLUDED.credit_sum,credit_state=EXCLUDED.credit_state,provision_sum=EXCLUDED.provision_sum,provision_state=EXCLUDED.provision_state,payment_components_status=EXCLUDED.payment_components_status,payment_stage=EXCLUDED.payment_stage,correction_status=EXCLUDED.correction_status,normalized_at=NOW()`, [receiptId, result.facts.normalizationVersion, result.facts.sourceContentSha256, result.facts.normalizedContentSha256, result.facts.normalizationStatus, result.facts.ffdVersionCode, result.facts.ffdVersion, result.facts.fiscalOperationType, result.facts.householdCashDirection, result.facts.cash_total_sum, result.facts.cash_total_state, result.facts.ecash_total_sum, result.facts.ecash_total_state, result.facts.prepaid_sum, result.facts.prepaid_state, result.facts.credit_sum, result.facts.credit_state, result.facts.provision_sum, result.facts.provision_state, result.facts.paymentComponentsStatus, result.facts.paymentStage, result.facts.correctionStatus]);
    await client.query('DELETE FROM receipt_item_fiscal_facts WHERE normalization_version=$1 AND receipt_item_id IN (SELECT id FROM receipt_items WHERE receipt_id=$2)', [normalizationVersion, receiptId]);
    for (const item of result.itemFacts) if (item.receiptItemId) await client.query('INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,payment_type_semantic,product_type_code,provider_inn,gtin,raw_product_code,normalized_content_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [item.receiptItemId, normalizationVersion, item.paymentTypeCode, item.paymentTypeSemantic, item.productTypeCode, item.providerInn, item.gtin, item.rawProductCode, fiscalContentFingerprint(item)]);
    await client.query('DELETE FROM normalization_issues WHERE receipt_id=$1 AND normalization_version=$2', [receiptId, normalizationVersion]);
    for (const issue of result.issues) await client.query('INSERT INTO normalization_issues(receipt_id,receipt_item_id,normalization_version,issue_code,details) VALUES($1,$2,$3,$4,$5)', [receiptId, issue.receiptItemId ?? null, normalizationVersion, issue.issueCode, issue.details]);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function backfillNormalization(pool, { normalizationVersion = NORMALIZATION_VERSION } = {}) {
  const rows = await pool.query('SELECT id FROM receipts ORDER BY id');
  const summary = { found: rows.rowCount, normalized: 0, ready: 0, blocked: 0, unsupported: 0, issues: 0 };
  for (const row of rows.rows) { const result = await normalizeAndStoreReceipt(pool, row.id, normalizationVersion); summary.normalized += 1; summary[result.facts.normalizationStatus.toLowerCase()] += 1; summary.issues += result.issues.length; }
  return summary;
}

export async function rebuildNormalization(pool, options = {}) {
  await pool.query('DELETE FROM normalization_issues; DELETE FROM receipt_item_fiscal_facts; DELETE FROM receipt_fiscal_facts;');
  return backfillNormalization(pool, options);
}
