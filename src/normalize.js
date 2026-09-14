function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/\s/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      if (value.trim() !== '') {
        return value.trim();
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

export function normalizeOperationType(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  if ((typeof text !== 'number' && typeof text !== 'string') || !/^[1-4]$/.test(String(text))) {
    return null;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeItems(rawItems = []) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems.map((item) => ({
    name: String(firstDefined(item?.name, item?.productName, item?.label) ?? ''),
    quantity: firstDefined(toNumber(item?.quantity), toNumber(item?.count), toNumber(item?.amount)),
    price: firstDefined(toNumber(item?.price), toNumber(item?.itemPrice), toNumber(item?.sumOfUnit)),
    sum: firstDefined(toNumber(item?.sum), toNumber(item?.total), toNumber(item?.amountSum)),
  }));
}

export function normalizeReceiptListItem(raw) {
  return {
    id: String(firstDefined(raw?.key, raw?.id, raw?.fiscalDocumentNumber) ?? ''),
    dateTime: firstDefined(raw?.createdDate, raw?.dateTime, raw?.date, null),
    seller: firstDefined(raw?.kktOwner, raw?.brand, raw?.user, raw?.retailPlace, raw?.seller, null),
    sellerInn: firstDefined(raw?.kktOwnerInn, raw?.userInn, raw?.inn, null),
    totalSum: firstDefined(toNumber(raw?.totalSum), toNumber(raw?.sum), null),
    currency: firstDefined(raw?.currency, raw?.currencyCode, raw?.totalCurrency, null),
  };
}

export function normalizeReceiptDetail(raw, { sourceId = null } = {}) {
  const items = normalizeItems(raw?.items);
  return {
    id: firstDefined(sourceId, raw?.key, raw?.id),
    dateTime: firstDefined(raw?.dateTime, raw?.createdDate, raw?.date, null),
    seller: firstDefined(raw?.kktOwner, raw?.user, raw?.retailPlace, raw?.brand, raw?.seller, null),
    sellerInn: firstDefined(raw?.kktOwnerInn, raw?.userInn, raw?.inn, null),
    totalSum: firstDefined(toNumber(raw?.totalSum), null),
    currency: firstDefined(raw?.currency, raw?.currencyCode, raw?.totalCurrency, null),
    operationType: normalizeOperationType(raw?.operationType),
    items,
  };
}

export { normalizeItems, toNumber, firstDefined };
