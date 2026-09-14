-- Accounting-Grade Audit v3.1. Read-only queries only; no DDL/DML.
-- Run from the project root with a PostgreSQL role that can SELECT audit tables.
-- Example: psql "$DATABASE_URL" -f scripts/accounting-audit-v3.1.sql

-- 1. Corpus and FFD support matrix.
SELECT count(*) AS receipts, (SELECT count(*) FROM receipt_items) AS items,
       (SELECT count(*) FROM receipt_raw) AS raw, min(date_time), max(date_time)
FROM receipts;
SELECT operation_type, count(*) FROM receipts GROUP BY operation_type ORDER BY operation_type;
SELECT payload->>'fiscalDocumentFormatVer' AS raw_ffd,
       CASE payload->>'fiscalDocumentFormatVer' WHEN '2' THEN '1.05' WHEN '3' THEN '1.1' WHEN '4' THEN '1.2' ELSE 'unknown' END AS semantic_ffd,
       count(*) FROM receipt_raw GROUP BY 1,2 ORDER BY 1;
WITH f AS (SELECT payload->>'fiscalDocumentFormatVer' ffd,payload FROM receipt_raw)
SELECT ffd, field, count(*) FILTER(WHERE present) AS present,
       count(*) FILTER(WHERE NOT present) AS missing,
       count(*) FILTER(WHERE present AND zero) AS zero
FROM (SELECT ffd,'cashTotalSum' field,payload?'cashTotalSum' present,coalesce(payload->>'cashTotalSum','')='0' zero FROM f
      UNION ALL SELECT ffd,'ecashTotalSum',payload?'ecashTotalSum',coalesce(payload->>'ecashTotalSum','')='0' FROM f
      UNION ALL SELECT ffd,'prepaidSum',payload?'prepaidSum',coalesce(payload->>'prepaidSum','')='0' FROM f
      UNION ALL SELECT ffd,'creditSum',payload?'creditSum',coalesce(payload->>'creditSum','')='0' FROM f
      UNION ALL SELECT ffd,'provisionSum',payload?'provisionSum',coalesce(payload->>'provisionSum','')='0' FROM f
      UNION ALL SELECT ffd,'correction',payload?'correction',false FROM f
      UNION ALL SELECT ffd,'allECashProp',payload?'allECashProp',false FROM f) s
GROUP BY ffd,field ORDER BY ffd,field;

-- 2. Full recursive path inventory. Values are reduced to counts and hashes.
WITH RECURSIVE walk(receipt_id,path,node) AS (
 SELECT receipt_id,'$',payload FROM receipt_raw
 UNION ALL
 SELECT w.receipt_id,CASE WHEN jsonb_typeof(w.node)='object' THEN w.path||'.'||e.key ELSE w.path||'[*]' END,e.value
 FROM walk w CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(w.node)='object' THEN w.node WHEN jsonb_typeof(w.node)='array' THEN COALESCE((SELECT jsonb_object_agg(i::text,v) FROM jsonb_array_elements(w.node) WITH ORDINALITY a(v,i)),'{}'::jsonb) ELSE '{}'::jsonb END) e
), leaves AS (SELECT path,node,jsonb_typeof(node) value_type FROM walk WHERE jsonb_typeof(node) NOT IN ('object','array'))
SELECT path,value_type,count(*) occurrences,
 count(DISTINCT md5(CASE WHEN value_type IN ('string','number','boolean') THEN node#>>'{}' ELSE 'JSON_NULL' END)) distinct_value_hashes,
 count(*) FILTER(WHERE value_type='null') json_nulls
FROM leaves GROUP BY path,value_type ORDER BY path,value_type;

-- 3. Operation/payment and reconciliation aggregates.
SELECT item->>'paymentType' AS item_payment_type,count(*)
FROM receipt_raw CROSS JOIN LATERAL jsonb_array_elements(payload->'items') item GROUP BY 1 ORDER BY 1;
SELECT count(*) FILTER(WHERE payload::text ~* 'market_payment_id') AS market_ref_rows,
       count(*) FILTER(WHERE payload::text ~* '(order[^" ]*id|payment[^" ]*id|merchant[^" ]*id|transaction[^" ]*id)') AS generic_ref_rows,
       count(*) FILTER(WHERE payload::text ~* '(correction|indicationFiscalSign|fiscalDocumentType|fiscalDocumentCode|correctionBasis|corrected)') AS correction_indicator_rows
FROM receipt_raw;
SELECT sum(total_sum) FILTER(WHERE operation_type=1) fiscal_positive,
       sum(total_sum) FILTER(WHERE operation_type=2) fiscal_returns,
       sum((payload->>'cashTotalSum')::numeric+(payload->>'ecashTotalSum')::numeric) FILTER(WHERE operation_type=1) new_cash,
       sum((payload->>'cashTotalSum')::numeric+(payload->>'ecashTotalSum')::numeric) FILTER(WHERE operation_type=2) return_cash,
       sum((payload->>'prepaidSum')::numeric) prepaid
FROM receipts r JOIN receipt_raw x ON x.receipt_id=r.id;

-- 4. Candidate lifecycle and returns.
-- The JSON artifacts contain the exact query predicates and row-level evidence.
-- Do not promote either result to AUTO matching.
SELECT operation_type,count(*) FROM receipts GROUP BY operation_type ORDER BY operation_type;

-- 5. Properties: shape/cardinality without exporting property values.
SELECT jsonb_typeof(payload->'properties') properties_type,
       count(*) FILTER(WHERE payload ? 'properties') property_rows,
       count(*) FILTER(WHERE payload ? 'propertiesData') properties_data_rows,
       count(*) FILTER(WHERE payload ? 'propertiesItem') properties_item_rows
FROM receipt_raw;
