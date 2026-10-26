#!/usr/bin/env bash
# Measure the two baselines under the same driver, round protocol and
# processor partition as the ledger configurations:
#
#   telog   a tamper-evident log run by a single operator (driver/telog):
#           SHA-256 hash chain, group commit with fsync, Ed25519-signed heads
#   couchdb a single CouchDB instance: no replication, chaining or signatures
#
# The network's containers are stopped for the duration, so each baseline has
# the network's processors (NET_CPUS) to itself, as the network did.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

NET_CPUS=${NET_CPUS:-0-5}
DRIVER_CPUS=${DRIVER_CPUS:-6-7}
PY=${PY:-python}
OUT=docs/measurements
HOSTPATH=$(pwd -W 2>/dev/null || pwd)
NET=antidoping_v2

blue() { printf '\033[0;34m[baselines]\033[0m %s\n' "$*"; }

docker build -q -t antidoping/driver:2.0 -f driver/Dockerfile . >/dev/null
"$PY" scripts/gen-baseline-plan.py --out driver/plans/baselines.json

blue "stopping the network so the baselines have its processors"
docker compose stop >/dev/null 2>&1 || true
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

docker rm -f baseline-telog baseline-couchdb >/dev/null 2>&1 || true
docker volume rm -f antidoping-telog-data >/dev/null 2>&1 || true
docker run -d --name baseline-telog --network "$NET" --cpuset-cpus "$NET_CPUS" \
  -v antidoping-telog-data:/data antidoping/driver:2.0 telog/server.js --port 8080 --file /data/log.ndjson >/dev/null
docker run -d --name baseline-couchdb --network "$NET" --cpuset-cpus "$NET_CPUS" \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=adminpw couchdb:3.3.3 >/dev/null
for _ in $(seq 1 60); do
  docker exec baseline-couchdb curl -sf http://admin:adminpw@localhost:5984/_up >/dev/null 2>&1 && break
  sleep 2
done
docker exec baseline-couchdb curl -s -X PUT http://admin:adminpw@localhost:5984/_users >/dev/null
docker exec baseline-couchdb curl -s -X PUT http://admin:adminpw@localhost:5984/custody >/dev/null

blue "running the baseline plan"
docker run --rm --name antidoping-driver --network "$NET" --cpuset-cpus "$DRIVER_CPUS" -e NO_FABRIC=1 \
  -v "$HOSTPATH/driver/plans":/app/driver/plans:ro -v "$HOSTPATH/$OUT":/out \
  antidoping/driver:2.0 bench.js --plan plans/baselines.json --out /out/baselines.json --workers 2

blue "verifying the tamper-evident log"
docker run --rm --network "$NET" antidoping/driver:2.0 -e \
  "fetch('http://baseline-telog:8080/verify').then(r=>r.json()).then(v=>{delete v.operatorKey;console.log(JSON.stringify(v))})" \
  > "$OUT/baseline-telog-verify.json"
cat "$OUT/baseline-telog-verify.json"

docker rm -f baseline-telog baseline-couchdb >/dev/null
docker volume rm -f antidoping-telog-data >/dev/null 2>&1 || true
blue "restarting the network"
docker compose start >/dev/null 2>&1 || true
blue "done: $OUT/baselines.json"
