import { ReceiptCollectorError } from './errors.js';

export class FiscalIdentityUnavailableError extends ReceiptCollectorError {
  constructor() {
    super('Fiscal identity is unavailable; similarity fallback is disabled', { code: 'FISCAL_IDENTITY_UNAVAILABLE' });
  }
}

export class FiscalIdentityConflictError extends ReceiptCollectorError {
  constructor() {
    super('FISCAL_IDENTITY_CONFLICT: source and canonical fiscal identities refer to different receipts', { code: 'FISCAL_IDENTITY_CONFLICT' });
  }
}

export class FiscalContentConflictError extends ReceiptCollectorError {
  constructor() {
    super('FISCAL_CONTENT_CONFLICT: same fiscal identity has different fiscal evidence', { code: 'FISCAL_CONTENT_CONFLICT' });
  }
}
