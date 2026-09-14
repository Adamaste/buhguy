import { ReceiptCollectorError } from './errors.js';

export class FnsSourceObservationConflictError extends ReceiptCollectorError {
  constructor() {
    super('FNS_SOURCE_OBSERVATION_CONFLICT: one source reference maps to multiple canonical receipts', { code: 'FNS_SOURCE_OBSERVATION_CONFLICT' });
  }
}
