#!/usr/bin/env node
import 'dotenv/config';
import { createPool } from '../src/database.js';
import { createBankIngestionServer } from '../src/bank-ingestion-http.js';

const pool = createPool();
const host = process.env.BANK_INGESTION_BIND_HOST || '127.0.0.1';
const port = Number(process.env.BANK_INGESTION_PORT || 8787);
const server = createBankIngestionServer({ pool });
server.listen(port, host, () => process.stderr.write(`bank ingestion listening on ${host}:${port}\n`));
const shutdown = async () => { server.close(); await pool.end(); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
