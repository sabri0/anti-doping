#!/usr/bin/env bash
# Run the Caliper benchmark against the running network.
#
# Caliper runs in a container attached to antidoping_net so that it resolves
# peers by container hostname, exactly as an in-cluster client would. The Docker
# socket is mounted so the resource monitor can sample peer CPU and memory
# during each round. The container runs as root because the bind-mounted
# crypto material is not readable by the image's unprivileged `node` user.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

REPORT=${REPORT:-benchmark/report.html}
CONFIG=${CONFIG:-benchmark/benchmark-config.yaml}
LOG=${LOG:-benchmark/caliper.log}

python scripts/gen-benchmark-config.py

# Stopping the shell that launched `docker run` does not stop the container it
# started. A previous run left behind this way keeps driving load and silently
# corrupts the next measurement, so any stray driver is removed first and the
# container is given a fixed name so a second concurrent run cannot start.
STRAY=$(docker ps -q --filter "ancestor=antidoping/caliper:0.6.0-fabric2.2")
if [ -n "$STRAY" ]; then
  echo "[benchmark] removing stray benchmark driver(s): $STRAY"
  docker kill $STRAY >/dev/null
fi

docker run --rm \
  --name antidoping-caliper \
  --network antidoping_net \
  --user 0:0 \
  -v "$(pwd -W 2>/dev/null || pwd)":/work \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -w /work \
  antidoping/caliper:0.6.0-fabric2.2 \
  launch manager \
  --caliper-workspace /work \
  --caliper-benchconfig "$CONFIG" \
  --caliper-networkconfig benchmark/generated/network-config.json \
  --caliper-report-path "/work/$REPORT" \
  --caliper-flow-only-test 2>&1 | tee "$LOG"

# Derive the evaluation documents from the run that just happened, so the
# reported numbers can never drift from the measurement behind them.
#
# Only the full suite may write the canonical documents. An ad-hoc run (a smoke
# test, a single round for resource sampling) would otherwise silently overwrite
# docs/benchmark-results.json and docs/EVALUATION.md with a partial measurement,
# and the paper's tables would then be generated from it.
echo "[benchmark] report      -> $REPORT"
echo "[benchmark] raw log     -> $LOG"

if [ "$CONFIG" = "benchmark/benchmark-config.yaml" ]; then
  python scripts/parse-benchmark.py "$LOG" -o docs/benchmark-results.json
  python scripts/gen-evaluation.py -r docs/benchmark-results.json -o docs/EVALUATION.md
  python scripts/gen-figures.py -r docs/benchmark-results.json || true
  echo "[benchmark] results     -> docs/benchmark-results.json"
  echo "[benchmark] evaluation  -> docs/EVALUATION.md"
else
  echo "[benchmark] partial run ($CONFIG): canonical results and EVALUATION.md left untouched"
fi
