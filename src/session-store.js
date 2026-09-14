import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function getDefaultStateDir() {
  return process.env.RECEIPT_COLLECTOR_STATE_DIR || path.join(process.cwd(), '.receipt-collector');
}

function nowIso() {
  return new Date().toISOString();
}

export class SessionStore {
  constructor({ stateDir = getDefaultStateDir() } = {}) {
    this.stateDir = stateDir;
    this.statePath = path.join(stateDir, 'session.json');
  }

  async ensureDir() {
    await fs.mkdir(this.stateDir, { recursive: true });
  }

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        keepTokens: parsed.keepTokens ?? true,
        deviceId: parsed.deviceId ?? crypto.randomUUID(),
        accessToken: parsed.accessToken ?? null,
        refreshToken: parsed.refreshToken ?? null,
        accessTokenExpiresAt: parsed.accessTokenExpiresAt ?? null,
        refreshTokenExpiresAt: parsed.refreshTokenExpiresAt ?? null,
        userAgent: parsed.userAgent ?? null,
        deviceInfo: parsed.deviceInfo ?? null,
        updatedAt: parsed.updatedAt ?? null,
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          keepTokens: true,
          deviceId: crypto.randomUUID(),
          accessToken: null,
          refreshToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          userAgent: null,
          deviceInfo: null,
          updatedAt: null,
        };
      }
      throw error;
    }
  }

  async save(state) {
    await this.ensureDir();
    const payload = {
      keepTokens: state.keepTokens ?? true,
      deviceId: state.deviceId ?? crypto.randomUUID(),
      accessToken: state.accessToken ?? null,
      refreshToken: state.refreshToken ?? null,
      accessTokenExpiresAt: state.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: state.refreshTokenExpiresAt ?? null,
      userAgent: state.userAgent ?? null,
      deviceInfo: state.deviceInfo ?? null,
      updatedAt: nowIso(),
    };
    const temporaryPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.chmod(temporaryPath, 0o600);
    try {
      await fs.rename(temporaryPath, this.statePath);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      await fs.rm(this.statePath, { force: true });
      await fs.rename(temporaryPath, this.statePath);
    }
    await fs.chmod(this.statePath, 0o600);
  }

  async clearTokens() {
    const state = await this.load();
    state.accessToken = null;
    state.refreshToken = null;
    state.accessTokenExpiresAt = null;
    state.refreshTokenExpiresAt = null;
    await this.save(state);
  }

  getDeviceInfo(state, userAgent = `Node.js ${process.version}`) {
    if (state.deviceInfo && typeof state.deviceInfo === 'object') {
      return {
        ...state.deviceInfo,
        sourceDeviceId: state.deviceInfo.sourceDeviceId ?? state.deviceId,
        metaDetails: {
          ...(state.deviceInfo.metaDetails ?? {}),
          userAgent: state.deviceInfo.metaDetails?.userAgent ?? userAgent,
        },
      };
    }
    return {
      sourceDeviceId: state.deviceId,
      sourceType: 'WEB',
      appVersion: '1.0.0',
      metaDetails: {
        userAgent,
      },
    };
  }

  isAccessExpired(state, clock = new Date()) {
    if (!state.accessToken || !state.accessTokenExpiresAt) {
      return false;
    }
    return new Date(state.accessTokenExpiresAt).getTime() <= clock.getTime();
  }
}
