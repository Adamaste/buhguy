import { assertSchemaCurrent, createPool, ReceiptRepository } from '../src/database.js';
import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';
import { syncReceipts } from '../src/sync.js';
import { runSourceSyncCycle } from '../src/source-sync-cycle.js';

const intervalMs = Math.max(60, Number(process.env.SYNC_INTERVAL_SECONDS || 900)) * 1000;
const pool = createPool();
const repository = new ReceiptRepository(pool);
let stopping = false;
let running = false;

async function runOnce() {
  if (running || stopping) return;
  running = true;
  try {
    await runSourceSyncCycle({ repository, logger: console, runSource: async ({ source, sourceRow }) => {
      const client = new FnsClient({ sessionStore: new SessionStore({ stateDir: source.sessionDir }), logger: console });
      return syncReceipts({ client, repository, accountKey: source.sourceKey, sourceContext: { sourceId: sourceRow.id, sourceKey: source.sourceKey }, pageSize: Number(process.env.SYNC_PAGE_SIZE || 50), logger: console });
    }});
  } finally { running = false; }
}

await assertSchemaCurrent(pool);
await runOnce();
const timer = setInterval(runOnce, intervalMs);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  while (running) await new Promise((resolve) => setTimeout(resolve, 250));
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
