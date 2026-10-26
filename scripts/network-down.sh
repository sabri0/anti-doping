#!/usr/bin/env bash
# Tear the network down. Pass --purge to also delete generated crypto material,
# channel artifacts and ledger volumes (required before a clean re-run).
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like absolute Unix paths
# (/work/... becomes C:/Program Files/Git/work/...). Container paths must survive verbatim.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

docker compose down --volumes --remove-orphans

if [ "${1:-}" = "--purge" ]; then
  rm -rf network/organizations/peerOrganizations \
         network/organizations/ordererOrganizations \
         network/organizations/fabric-ca \
         network/organizations/cas \
         network/channel-artifacts
  docker rm -f custodyv1-cc >/dev/null 2>&1 || true
  echo "[network-down] purged crypto material and channel artifacts"
fi
echo "[network-down] done"
