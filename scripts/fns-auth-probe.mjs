import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';

const client = new FnsClient({ sessionStore: new SessionStore() });
const page = await client.listReceipts({ limit: 1, offset: 0, kktOwner: '' });
console.log(JSON.stringify({ ok: true, count: page.receipts.length, hasMore: page.hasMore }));
