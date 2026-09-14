#!/usr/bin/env node
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const configPath = '/etc/finance-receipt-collector/fns-sources.json';
const root = '/opt/accountant/receipt-collector/.receipt-collector/users/';
const sourceKeyPattern = /^fns-onboarding-[a-f0-9]{16}$/;
const allowedAdditionalSourceKeys = new Set([
  'fns-onboarding-e33cdda7194a94e6',
  'fns-onboarding-6200a906e9f34b08',
]);

function fail(code) { process.stderr.write(`${code}\n`); process.exit(126); }
function safeSource(source) {
  if (!source || !sourceKeyPattern.test(String(source.sourceKey ?? ''))) fail('CONFIG_UPDATE_SOURCE_DENIED');
  const sourceKey = String(source.sourceKey);
  const sessionDir = path.resolve(String(source.sessionDir ?? ''));
  if (sessionDir !== path.join(root, sourceKey)) fail('CONFIG_UPDATE_SESSION_PATH_DENIED');
  if (source.scopeKey !== 'default' || !source.displayName || !source.personKey || !source.personDisplayName) fail('CONFIG_UPDATE_METADATA_DENIED');
  return {
    sourceKey,
    displayName: String(source.displayName),
    scopeKey: 'default',
    personKey: String(source.personKey),
    personDisplayName: String(source.personDisplayName),
    sessionDir,
    sessionRef: `filesystem:${sessionDir}/session.json`,
    deviceRef: `filesystem:${sessionDir}/device.json`,
  };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input);
    if (!['enable', 'upsert-disabled'].includes(request.operation)) fail('CONFIG_UPDATE_OPERATION_DENIED');
    const source = safeSource(request.source);
    const current = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const configStat = await fs.stat(configPath);
    if (!Array.isArray(current) || current.length > 4) fail('CONFIG_UPDATE_SOURCE_COUNT_DENIED');
    const index = current.findIndex((item) => item.sourceKey === source.sourceKey);
    const nextSource = { ...source, enabled: request.operation === 'enable' };
    const next = index < 0 ? [...current, nextSource] : current.map((item, itemIndex) => itemIndex === index ? { ...item, ...nextSource } : item);
    if (next.length > 2 && !allowedAdditionalSourceKeys.has(source.sourceKey)) fail('CONFIG_UPDATE_THIRD_SOURCE_DENIED');
    const backupPath = `${configPath}.bak`;
    await fs.copyFile(configPath, backupPath);
    await fs.chmod(backupPath, 0o600);
    const temporary = `${configPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.chown(temporary, configStat.uid, configStat.gid);
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, configPath);
    await fs.chmod(configPath, 0o600);
    process.stdout.write(JSON.stringify({ ok: true, backupPath, added: index < 0 }) + '\n');
  } catch (error) {
    if (error?.code === 'ENOENT') fail('CONFIG_UPDATE_FILE_NOT_FOUND');
    if (String(error?.message).startsWith('CONFIG_UPDATE_')) fail(error.message);
    fail('CONFIG_UPDATE_FAILED');
  }
});
