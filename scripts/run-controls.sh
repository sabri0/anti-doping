#!/usr/bin/env bash
# Control measurements that accompany the main benchmark suite.
#
#   1. driver saturation — the two highest sweep points repeated with a
#      six-worker load driver, to establish whether the driver or the network
#      bounded the measured throughput
#   2. resource attribution — container CPU sampled throughout one saturating
#      write round, at a fixed interval, so the split carries an n
#   3. centralised control arm — the same custody write against a single
#      unreplicated CouchDB with no endorsement, ordering or validation
#
# Run after ./scripts/run-benchmark.sh, against the same running network.
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

PY=${PY:-python}
OUT=${OUT:-docs}
BASELINE_REPS=${BASELINE_REPS:-3}

blue() { printf '\033[0;34m[controls]\033[0m %s\n' "$*"; }

# ------------------------------------------------------------ 1. driver control
blue "driver-saturation control (six workers)"
CONFIG=benchmark/driver-control.yaml \
REPORT=benchmark/driver-control.html \
LOG=benchmark/driver-control.log \
  bash scripts/run-benchmark.sh >/dev/null 2>&1
"$PY" scripts/parse-benchmark.py benchmark/driver-control.log -o "$OUT/driver-control.json"
blue "driver control -> $OUT/driver-control.json"

# --------------------------------------------------------- 2. resource sampling
blue "resource attribution (sampled throughout a saturating round)"
"$PY" scripts/sample-resources.py --interval 5 --out "$OUT/resource-metrics.json"

# ------------------------------------------------------- 3. centralised control
blue "centralised control arm"
docker rm -f baseline-couchdb >/dev/null 2>&1
docker run -d --name baseline-couchdb --network antidoping_net \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=adminpw \
  couchdb:3.3.3 >/dev/null

# CouchDB needs a moment before it accepts writes; poll rather than sleep blind.
# The poll runs in the benchmark image, which is already local, so no pull.
for _ in $(seq 1 30); do
  if docker run --rm --network antidoping_net --entrypoint node \
       antidoping/caliper:0.6.0-fabric2.2 \
       -e "require('http').get('http://baseline-couchdb:5984/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
       >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Concurrency is set well above the point where the control's own driver binds:
# at two workers the arm reported 44 TPS with a 45 ms round trip, which is two
# requests in flight, not a property of the database.
RESULTS="["
for i in $(seq 1 "$BASELINE_REPS"); do
  blue "  baseline replicate $i"
  LINE=$(docker run --rm --network antidoping_net \
    -v "$(pwd -W 2>/dev/null || pwd)":/work -w /work \
    --entrypoint node antidoping/caliper:0.6.0-fabric2.2 \
    benchmark/baseline/centralised-baseline.js \
      --url http://baseline-couchdb:5984 --db "custody-baseline-$i" \
      --tps 400 --tx 4000 --workers 24 --label "baseline-r$i" 2>/dev/null | tail -1)
  echo "    $LINE"
  RESULTS="$RESULTS$LINE,"
done
RESULTS="${RESULTS%,}]"
printf '%s\n' "$RESULTS" > "$OUT/baseline-results.json"
docker rm -f baseline-couchdb >/dev/null 2>&1
blue "centralised control -> $OUT/baseline-results.json"
