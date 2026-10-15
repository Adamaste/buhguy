function lockName(kind, value) {
  return `buhguy:${kind}:${String(value)}`;
}

export async function lockMatchedPurchaseScope(client, scopeKey) {
  // Session locks are acquired before BEGIN so repeatable/serializable callers
  // take their snapshot only after waiting for the same scope's writer.
  const key = lockName('accounting-scope', scopeKey);
  await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
  };
}

export async function lockMatchedPurchaseScopeTransaction(client, scopeKey) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockName('accounting-scope', scopeKey)]);
}

export async function lockMatchedPurchaseBankTransaction(client, bankTransactionId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockName('bank-transaction', bankTransactionId)]);
}

export async function lockMatchedPurchaseSourceProvider(client, bankSourceId, provider) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockName('source-provider', `${bankSourceId}:${provider}`)]);
}
