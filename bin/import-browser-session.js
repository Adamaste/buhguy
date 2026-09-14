#!/usr/bin/env node
import { importBrowserSession } from '../src/browser-session-import.js';

const stateDir = process.env.RECEIPT_COLLECTOR_STATE_DIR || '/opt/accountant/receipt-collector/.receipt-collector';
const cdpUrl = process.env.FNS_CDP_URL || 'http://127.0.0.1:9222';
await importBrowserSession({ stateDir, cdpUrl });
console.log(JSON.stringify({ ok: true, imported: true }));
