#!/usr/bin/env bash
# Run the full evaluation of the currently deployed network configuration.
#
#   1. the regulatory scenarios
#   2. one saturating round with container processor use sampled throughout
#   3. the measurement plan (driver/plans/<CONFIG>.json)
#
# The load driver runs in its own container pinned to DRIVER_CPUS, processors
# that no network container may use (NET_CPUS, set when the network was
# generated), so the driver does not compete with the system it measures.
#
#   CONFIG=K1 ./scripts/run-evaluation.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CONFIG=${CONFIG:?set CONFIG, e.g. K1}
DRIVER_CPUS=${DRIVER_CPUS:-6-7}
NET_CPU_COUNT=${NET_CPU_COUNT:-6}
WORKERS=${WORKERS:-2}
CPU_CONCURRENCY=${CPU_CONCURRENCY:-32}
PY=${PY:-python}
OUT=docs/measurements
HOSTPATH=$(pwd -W 2>/dev/null || pwd)
mkdir -p "$OUT"

blue() { printf '\033[0;34m[evaluation %s]\033[0m %s\n' "$CONFIG" "$*"; }

driver() {
  docker run --rm --name antidoping-driver --network antidoping_v2 --cpuset-cpus "$DRIVER_CPUS" \
    -v "$HOSTPATH/network/organizations":/work/network/organizations:ro \
    -v "$HOSTPATH/driver/plans":/app/driver/plans:ro \
    -v "$HOSTPATH/$OUT":/out \
    antidoping/driver:2.0 "$@"
}

blue "building the driver image"
docker build -q -t antidoping/driver:2.0 -f driver/Dockerfile . >/dev/null

blue "regulatory scenarios"
driver -e "process.env.SCENARIO_OUT='/out/$CONFIG-scenarios.json'; require('./scenarios.js')" | tail -3

if docker ps --format '{{.Names}}' | grep -q '^couchdb0-federation$'; then
  blue "state databases holding private-collection content, per peer"
  OUT="$OUT/$CONFIG-storage.json" bash scripts/evidence-storage.sh
fi

blue "processor attribution during a saturating round"
cat > driver/plans/$CONFIG-cpu.json <<EOF
{ "name": "$CONFIG-cpu", "rounds": [
  {"id":"cpu","workload":"initiateSampleCustody","concurrency":$CPU_CONCURRENCY,"warmup":15,"duration":75}
]}
EOF
driver bench.js --plan plans/$CONFIG-cpu.json --out /out/$CONFIG-cpu-round.json --workers "$WORKERS" > /dev/null &
DRIVER_PID=$!
"$PY" scripts/sample-cpu.py --delay 22 --duration 60 --interval 3 --net-cpus "$NET_CPU_COUNT" --out "$OUT/$CONFIG-cpu.json"
wait $DRIVER_PID

blue "measurement plan"
driver bench.js --plan plans/$CONFIG.json --out /out/$CONFIG.json --workers "$WORKERS"
blue "done: $OUT/$CONFIG.json"
