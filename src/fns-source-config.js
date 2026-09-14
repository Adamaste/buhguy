import { promises as fs } from 'node:fs';

// Configuration contains references only. Auth state remains in each SessionStore directory.
export async function loadFnsSourceConfig(file = process.env.FNS_SOURCES_CONFIG) {
  if (!file) return null;
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('FNS_SOURCES_CONFIG must contain an array');
  return parsed.map((source) => {
    if (!source.sourceKey || !source.sessionDir) throw new Error('Each FNS source needs sourceKey and sessionDir');
    return { enabled: source.enabled !== false, scopeKey: source.scopeKey ?? 'default', sourceKey: source.sourceKey, displayName: source.displayName ?? null, personKey: source.personKey ?? null, personDisplayName: source.personDisplayName ?? null, sessionDir: source.sessionDir, sessionRef: source.sessionRef ?? `filesystem:${source.sessionDir}`, deviceRef: source.deviceRef ?? null };
  });
}
