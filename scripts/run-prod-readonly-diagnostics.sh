#!/usr/bin/env bash
set -euo pipefail
set -a
. /etc/finance-receipt-collector/receipt-collector.env
set +a
APP_ROOT=/opt/accountant/receipt-collector OUTPUT_DIR=/tmp/layer-gaps-predeploy node /opt/accountant/receipt-collector/scripts/run-layer-gaps-tech-debt.mjs
COVERAGE_OUTPUT_DIR=/tmp/coverage-gate-predeploy node /opt/accountant/receipt-collector/scripts/run-accounting-coverage-gate.mjs
