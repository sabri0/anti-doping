#!/usr/bin/env bash
# Run the rest of the evaluation after K1: K2, K3, the test suites and the
# insider comparison on the K3 network, then the baselines. Waits for the K1
# run to finish first, so nothing competes with a measurement.
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
export PY=${PY:-python}
LOG=docs/measurements/remaining.log
say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }

say "waiting for K1 to finish"
until grep -q "^exit" docs/measurements/K1-run.log 2>/dev/null; do sleep 60; done
say "K1 finished: $(tail -1 docs/measurements/K1-run.log)"

for spec in "K2 raft goleveldb" "K3 bft goleveldb"; do
  set -- $spec
  say "starting $1 ($2, $3)"
  CONFIG=$1 CONSENSUS=$2 STATE_DB=$3 bash scripts/evaluate-configuration.sh > "docs/measurements/$1-run.log" 2>&1
  status=$?
  echo "exit $status" >> "docs/measurements/$1-run.log"
  say "$1 finished with exit $status"
done

say "test suites"
bash scripts/run-tests.sh >> "$LOG" 2>&1

say "insider comparison against the first-cycle contract"
bash scripts/deploy-v1-reference.sh >> "$LOG" 2>&1
(cd driver && PEER_HOST=localhost CRYPTO_ROOT=../network/organizations INSIDER_OUT=../docs/insider-comparison.json \
  node insider-comparison.js) >> "$LOG" 2>&1
say "insider comparison exit $?"

say "baselines"
bash scripts/run-baselines.sh > docs/measurements/baselines-run.log 2>&1
say "baselines exit $?"
say "all done"
