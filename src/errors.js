export class ReceiptCollectorError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? null;
    this.status = options.status ?? null;
    this.details = options.details ?? null;
  }
}

export class ApiError extends ReceiptCollectorError {}
export class AuthRequiredError extends ReceiptCollectorError {}
export class CaptchaRequiredError extends ReceiptCollectorError {}
export class SmsRequiredError extends ReceiptCollectorError {}
export class SessionExpiredError extends ReceiptCollectorError {}
