#!/usr/bin/env bash
# Evaluate K2 (Raft, LevelDB) and K3 (SmartBFT, LevelDB), then repeat the
# insider comparison on the final network.
#
# LevelDB configurations are latency-bound, not saturated, at concurrency 32
# (closed-loop throughput is concurrency divided by latency), so their sweep
# extends to 256 and their capacity rounds run at 128. A short probe after
# bring-up sets the expected throughput used to size the provisioned pools.
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
export PY=${PY:-python}
LOG=docs/measurements/remaining.log
HOSTPATH=$(pwd -W 2>/dev/null || pwd)
say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }

for spec in "K2 raft goleveldb 11" "K3 bft goleveldb 12"; do
  set -- $spec
  CONFIG=$1 CONSENSUS=$2 STATE_DB=$3 SEED=$4
  say "$CONFIG: bringing up ($CONSENSUS, $STATE_DB)"
  bash scripts/network-down.sh --purge >/dev/null 2>&1 || true
  CONSENSUS=$CONSENSUS STATE_DB=$STATE_DB bash scripts/network-up.sh > "docs/measurements/$CONFIG-network-up.log" 2>&1
  bash scripts/deploy-chaincode.sh > "docs/measurements/$CONFIG-deploy.log" 2>&1
  if ! grep -q "Name: custody," "docs/measurements/$CONFIG-deploy.log"; then
    say "$CONFIG: deployment failed"; continue
  fi

  say "$CONFIG: probe"
  docker build -q -t antidoping/driver:2.0 -f driver/Dockerfile . >/dev/null
  cat > driver/plans/$CONFIG-probe.json <<EOF
{ "name": "$CONFIG-probe", "rounds": [
  {"id":"p64","workload":"initiateSampleCustody","concurrency":64,"warmup":10,"duration":20},
  {"id":"p128","workload":"initiateSampleCustody","concurrency":128,"warmup":10,"duration":20},
  {"id":"p256","workload":"initiateSampleCustody","concurrency":256,"warmup":10,"duration":20}
]}
EOF
  docker run --rm --name antidoping-driver --network antidoping_v2 --cpuset-cpus 6-7 \
    -v "$HOSTPATH/network/organizations":/work/network/organizations:ro \
    -v "$HOSTPATH/driver/plans":/app/driver/plans:ro -v "$HOSTPATH/docs/measurements":/out \
    antidoping/driver:2.0 bench.js --plan plans/$CONFIG-probe.json --out /out/$CONFIG-probe.json --workers 2 >> "$LOG" 2>&1
  EXPECT=$("$PY" -c "import json;d=json.load(open('docs/measurements/$CONFIG-probe.json'));print(round(max(r['committedTps'] for r in d['rounds']),1))")
  say "$CONFIG: probe maximum $EXPECT tx/s"

  "$PY" scripts/gen-evaluation-plan.py --config "$CONFIG" \
    --description "$CONSENSUS (4 nodes, 4 organisations), $STATE_DB state databases, Fabric 3.1.5" \
    --expect "$EXPECT" --seed "$SEED" --sweep 4,8,16,32,64,128,256 --capacity-concurrency 128 \
    --out "driver/plans/$CONFIG.json" >> "$LOG"
  CONFIG=$CONFIG CPU_CONCURRENCY=128 bash scripts/run-evaluation.sh > "docs/measurements/$CONFIG-run.log" 2>&1
  status=$?
  echo "exit $status" >> "docs/measurements/$CONFIG-run.log"
  say "$CONFIG finished with exit $status"
done

say "insider comparison against the first-cycle contract (K3 network)"
bash scripts/deploy-v1-reference.sh >> "$LOG" 2>&1
sleep 10
(cd driver && PEER_HOST=localhost CRYPTO_ROOT=../network/organizations INSIDER_OUT=../docs/insider-comparison.json \
  node insider-comparison.js) >> "$LOG" 2>&1
say "insider comparison exit $?"
say "K2/K3 chain done"
