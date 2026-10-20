export function assertDisposableLocalTestDatabase(connectionString) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('TEST_DATABASE_URL must use PostgreSQL');
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Destructive PostgreSQL integration tests are restricted to localhost');
  }
  if (['host', 'hostaddr', 'service'].some((key) => url.searchParams.has(key))) {
    throw new Error('TEST_DATABASE_URL cannot override the local PostgreSQL host');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^finance_receipt_collector_test_[a-zA-Z0-9_]+$/.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL must target a disposable finance_receipt_collector_test_ database');
  }
  return databaseName;
}
