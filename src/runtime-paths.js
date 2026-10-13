import { fileURLToPath } from 'node:url';

const RECEIPT_COLLECTOR_ENTRYPOINT = fileURLToPath(new URL('../bin/receipt-collector.js', import.meta.url));

export function onboardingFinishInvocation(nameOrSource, cwd = process.cwd()) {
  return {
    file: process.execPath,
    args: [RECEIPT_COLLECTOR_ENTRYPOINT, 'fns-user', 'finish', nameOrSource],
    cwd,
  };
}

