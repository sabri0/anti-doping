#!/usr/bin/env bash
# Evaluate one network configuration from a clean start:
# tear down, bring up, deploy, then run scenarios and the measurement plan.
#
#   CONFIG=K2 CONSENSUS=raft STATE_DB=goleveldb ./scripts/evaluate-configuration.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
: "${CONFIG:?}" "${CONSENSUS:?}" "${STATE_DB:?}"
bash scripts/network-down.sh --purge >/dev/null 2>&1 || true
CONSENSUS=$CONSENSUS STATE_DB=$STATE_DB bash scripts/network-up.sh > "docs/measurements/$CONFIG-network-up.log" 2>&1
bash scripts/deploy-chaincode.sh > "docs/measurements/$CONFIG-deploy.log" 2>&1
grep -q "Name: custody," "docs/measurements/$CONFIG-deploy.log" || { echo "deployment failed for $CONFIG" >&2; exit 1; }
CONFIG=$CONFIG bash scripts/run-evaluation.sh
