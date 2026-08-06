#!/usr/bin/env bash
# Bring up the full anti-doping governance network.
#
#   1. start the six certification authorities
#   2. enroll every organizational identity against its own CA
#   3. start orderer, peers, CouchDB state stores and the IPFS cluster
#   4. create the channel and join all ten peers
#
# Everything runs in containers; the host needs only Docker.
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like absolute Unix paths
# (/work/... becomes C:/Program Files/Git/work/...). Container paths must survive verbatim.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CAS=(ca-athlete ca-federation ca-nado ca-lab ca-research ca-orderer)
ORGS=(athlete federation nado lab research)

blue() { printf '\033[0;34m[network-up]\033[0m %s\n' "$*"; }

blue "clearing previous cryptographic material"
rm -rf network/organizations/peerOrganizations \
       network/organizations/ordererOrganizations \
       network/organizations/fabric-ca \
       network/channel-artifacts
mkdir -p network/channel-artifacts
for o in "${ORGS[@]}" orderer; do mkdir -p "network/organizations/fabric-ca/$o"; done

blue "starting certification authorities"
docker compose up -d "${CAS[@]}" ca-tools

blue "waiting for CA signing certificates"
for o in "${ORGS[@]}" orderer; do
  for _ in $(seq 1 60); do
    [ -f "network/organizations/fabric-ca/$o/ca-cert.pem" ] && break
    sleep 1
  done
  if [ ! -f "network/organizations/fabric-ca/$o/ca-cert.pem" ]; then
    echo "ERROR: ca-$o never produced ca-cert.pem" >&2
    docker compose logs --tail 40 "ca-$o" >&2
    exit 1
  fi
done

blue "enrolling identities (6 CAs)"
docker compose exec -T ca-tools sh /work/scripts/registerEnroll.sh

blue "starting orderer, peers, state databases and IPFS"
docker compose up -d orderer.antidoping.org ipfs0 ipfs1 ipfs2 cli
for o in "${ORGS[@]}"; do
  docker compose up -d "peer0.$o.antidoping.org" "peer1.$o.antidoping.org"
done

blue "waiting for the ordering service"
for _ in $(seq 1 60); do
  docker compose logs orderer.antidoping.org 2>/dev/null | grep -q "Beginning to serve requests" && break
  sleep 2
done

./scripts/create-channel.sh

blue "network is up"
docker compose ps --format 'table {{.Name}}\t{{.Status}}' | head -40
