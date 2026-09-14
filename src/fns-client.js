import { ApiError, AuthRequiredError, CaptchaRequiredError, SessionExpiredError, SmsRequiredError } from './errors.js';
import { normalizeReceiptDetail, normalizeReceiptListItem } from './normalize.js';

function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function parseExpiresAt(expiresIn) {
  if (expiresIn === null || expiresIn === undefined || expiresIn === '') {
    return null;
  }

  const parsed = Number(expiresIn);
  if (Number.isFinite(parsed)) {
    return new Date(Date.now() + parsed * 1000).toISOString();
  }

  const asDate = new Date(expiresIn);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractApiError(body, status, fallbackMessage) {
  const code = body && typeof body === 'object' ? body.code ?? body.errorCode ?? body.type ?? null : null;
  const message = body && typeof body === 'object'
    ? body.message ?? body.error ?? body.detail ?? fallbackMessage
    : fallbackMessage;
  return new ApiError(message || fallbackMessage || 'Request failed', { status, code, details: body });
}

function isCaptchaRelated(error) {
  const code = String(error?.code ?? error?.details?.code ?? '').toLowerCase();
  const message = String(error?.message ?? '').toLowerCase();
  return code.includes('captcha') || message.includes('captcha');
}

function isSmsRelated(error) {
  const code = String(error?.code ?? error?.details?.code ?? '').toLowerCase();
  const message = String(error?.message ?? '').toLowerCase();
  return code.includes('sms') || message.includes('sms') || message.includes('verification code');
}

function isAccessTokenExpired(error) {
  const code = String(error?.code ?? error?.details?.code ?? '').toLowerCase();
  return code === 'authentication.failed.expired.token';
}

export class FnsClient {
  constructor({
    baseUrl = 'https://lkdr.nalog.ru',
    fetchImpl = fetch,
    sessionStore,
    logger = console,
  } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.sessionStore = sessionStore;
    this.logger = logger;
    this._refreshInFlight = null;
  }

  async loadState() {
    if (!this.sessionStore) {
      throw new Error('Session store is required');
    }
    return this.sessionStore.load();
  }

  async saveState(state) {
    if (!this.sessionStore) {
      throw new Error('Session store is required');
    }
    await this.sessionStore.save(state);
  }

  async clearSession() {
    if (!this.sessionStore) {
      return;
    }
    await this.sessionStore.clearTokens();
  }

  async request(path, {
    method = 'GET',
    query,
    body,
    auth = true,
    retryOnAuthFailure = true,
    state,
  } = {}) {
    const session = state ?? (this.sessionStore ? await this.sessionStore.load() : null);
    const url = buildUrl(this.baseUrl, path, query);
    const headers = {
      Accept: 'application/json',
    };

    let token = session?.accessToken ?? null;
    if (auth && token && session?.accessTokenExpiresAt && new Date(session.accessTokenExpiresAt).getTime() <= Date.now()) {
      const refreshed = await this.refreshSession(session);
      token = refreshed.accessToken;
    }

    if (auth && token && !['/api/v2/auth/challenge/phone/start', '/api/v1/auth/challenge/phone/verify', '/api/v1/auth/token'].includes(path)) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const parsed = await parseResponseBody(response);
      const apiError = extractApiError(parsed, response.status, response.statusText);
      if (
        retryOnAuthFailure &&
        auth &&
        (response.status === 401 || isAccessTokenExpired(apiError)) &&
        session?.refreshToken &&
        path !== '/api/v1/auth/token' &&
        path !== '/api/v1/auth/challenge/phone/verify' &&
        path !== '/api/v2/auth/challenge/phone/start'
      ) {
        const refreshed = await this.refreshSession(session);
        return this.request(path, {
          method,
          query,
          body,
          auth,
          retryOnAuthFailure: false,
          state: refreshed,
        });
      }
      throw apiError;
    }

    return parseResponseBody(response);
  }

  async startPhoneChallenge({ phone, captchaToken, deviceInfo }) {
    if (!phone) {
      throw new AuthRequiredError('Phone number is required to start login');
    }

    try {
      return await this.request('/api/v2/auth/challenge/phone/start', {
        method: 'POST',
        body: { phone, captchaToken, deviceInfo },
        auth: false,
      });
    } catch (error) {
      if (error instanceof ApiError && isCaptchaRelated(error)) {
        throw new CaptchaRequiredError(
          'FNS requires CAPTCHA for the login start step. Complete the official browser flow on https://lkdr.nalog.ru/login, then rerun receipt-collector login with the required challenge data.',
          { status: error.status, code: error.code, details: error.details },
        );
      }
      throw error;
    }
  }

  async verifyPhoneChallenge({ challengeToken, phone, code, saveCredentials = true, deviceInfo }) {
    if (!challengeToken) {
      throw new AuthRequiredError('challengeToken is required');
    }
    if (!phone) {
      throw new AuthRequiredError('phone is required');
    }
    if (!code) {
      throw new AuthRequiredError('SMS code is required');
    }

    let data;
    try {
      data = await this.request('/api/v1/auth/challenge/phone/verify', {
        method: 'POST',
        body: { challengeToken, phone, code, deviceInfo },
        auth: false,
      });
    } catch (error) {
      if (error instanceof ApiError && isSmsRelated(error)) {
        throw new SmsRequiredError(
          'The SMS code was rejected or expired. Request a fresh code in the official FNS flow and rerun receipt-collector login.',
          { status: error.status, code: error.code, details: error.details },
        );
      }
      throw error;
    }

    if (this.sessionStore && saveCredentials) {
      const state = await this.sessionStore.load();
      await this.sessionStore.save({
        ...state,
        accessToken: data.token ?? null,
        refreshToken: data.refreshToken ?? null,
        accessTokenExpiresAt: parseExpiresAt(data.tokenExpireIn),
        refreshTokenExpiresAt: parseExpiresAt(data.refreshTokenExpiresIn),
        userAgent: data.userAgent ?? state.userAgent,
        deviceInfo: data.deviceInfo ?? state.deviceInfo,
      });
    }

    return data;
  }

  async refreshSession(session) {
    if (this._refreshInFlight) {
      return this._refreshInFlight;
    }

    if (!session?.refreshToken) {
      throw new SessionExpiredError('No refresh token available', { code: 'AUTH_RELOGIN_REQUIRED' });
    }

    this._refreshInFlight = (async () => {
      if (this.sessionStore) {
        const current = await this.sessionStore.load();
        const currentExpiry = current.accessTokenExpiresAt ? new Date(current.accessTokenExpiresAt).getTime() : null;
        if (
          current.accessToken &&
          current.accessToken !== session.accessToken &&
          (currentExpiry === null || currentExpiry > Date.now())
        ) {
          return current;
        }
      }

      const deviceInfo = this.sessionStore
        ? this.sessionStore.getDeviceInfo(session, session.userAgent ?? undefined)
        : { sourceDeviceId: 'unknown', sourceType: 'WEB', appVersion: '1.0.0', metaDetails: { userAgent: 'node' } };

      let data;
      try {
        data = await this.request('/api/v1/auth/token', {
          method: 'POST',
          body: { refreshToken: session.refreshToken, deviceInfo },
          auth: false,
        });
      } catch (error) {
        if (error instanceof ApiError) {
          throw new SessionExpiredError('FNS session refresh failed', {
            status: error.status,
            code: 'AUTH_RELOGIN_REQUIRED',
            details: { fnsCode: error.code },
          });
        }
        throw error;
      }

      const nextState = {
        ...session,
        accessToken: data.token ?? null,
        refreshToken: data.refreshToken ?? session.refreshToken,
        accessTokenExpiresAt: parseExpiresAt(data.tokenExpireIn),
        refreshTokenExpiresAt: parseExpiresAt(data.refreshTokenExpiresIn),
      };

      if (this.sessionStore) {
        await this.sessionStore.save(nextState);
      }

      return nextState;
    })();

    try {
      return await this._refreshInFlight;
    } finally {
      this._refreshInFlight = null;
    }
  }

  async getProfile() {
    const data = await this.request('/api/v1/user/profile');
    return data?.user ?? null;
  }

  async listReceipts(params = {}) {
    const data = await this.request('/api/v1/receipt', {
      method: 'POST',
      body: {
        limit: params.limit ?? 10,
        offset: params.offset ?? 0,
        dateFrom: params.dateFrom ?? null,
        dateTo: params.dateTo ?? null,
        orderBy: params.orderBy ?? null,
        inn: params.inn ?? null,
        kktOwner: params.kktOwner ?? '',
      },
    });

    const receipts = Array.isArray(data?.receipts) ? data.receipts.map(normalizeReceiptListItem) : [];
    return {
      hasMore: Boolean(data?.hasMore),
      receipts,
      brands: Array.isArray(data?.brands) ? data.brands : [],
      raw: data,
    };
  }

  async getReceiptRaw(key) {
    if (!key) {
      throw new AuthRequiredError('Receipt key is required');
    }
    return this.request('/api/v1/receipt/fiscal_data', {
      method: 'POST',
      body: { key },
    });
  }

  async getReceipt(key, { includeRaw = false } = {}) {
    const raw = await this.getReceiptRaw(key);
    const receipt = normalizeReceiptDetail(raw);
    if (includeRaw) {
      return { receipt, raw };
    }
    return receipt;
  }
}
