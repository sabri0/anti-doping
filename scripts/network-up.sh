#!/usr/bin/env bash
# Bring up the full anti-doping governance network.
#
#   1. start the five certification authorities
#   2. enroll every organisational identity against its own CA
#   3. start the four ordering nodes, the peers, their state databases and IPFS
#   4. create the channel under the chosen consensus protocol and join all peers
#
#   CONSENSUS=raft|bft   ordering protocol (default raft)
#   STATE_DB=couchdb|goleveldb   peer state database (default couchdb)
#   NET_CPUS=0-5         processors the network containers are pinned to
#
# Everything runs in containers; the host needs only Docker.
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like absolute Unix paths
# (/work/... becomes C:/Program Files/Git/work/...). Container paths must survive verbatim.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CONSENSUS=${CONSENSUS:-raft}
STATE_DB=${STATE_DB:-couchdb}
NET_CPUS=${NET_CPUS:-0-5}
PY=${PY:-python}
CAS=(ca-athlete ca-federation ca-nado ca-lab ca-research)
ORGS=(athlete federation nado lab research)
ORDERER_ORGS=(athlete federation nado lab)

blue() { printf '\033[0;34m[network-up]\033[0m %s\n' "$*"; }

blue "consensus=$CONSENSUS state-db=$STATE_DB network-cpus=$NET_CPUS"
[ -x network/tools/bin/peer ] || bash scripts/fetch-fabric-binaries.sh
"$PY" scripts/gen-compose.py --state-db "$STATE_DB" --net-cpus "$NET_CPUS"
printf '%s\n' "$CONSENSUS" > network/.consensus

blue "clearing previous cryptographic material"
rm -rf network/organizations/peerOrganizations \
       network/organizations/ordererOrganizations \
       network/organizations/fabric-ca \
       network/organizations/cas \
       network/channel-artifacts
mkdir -p network/channel-artifacts
for o in "${ORGS[@]}"; do mkdir -p "network/organizations/fabric-ca/$o"; done

blue "starting certification authorities"
docker compose up -d "${CAS[@]}" ca-tools

blue "waiting for CA signing certificates"
for o in "${ORGS[@]}"; do
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

blue "enrolling identities (5 CAs, 4 ordering nodes, 10 peers)"
docker compose exec -T ca-tools sh /work/scripts/registerEnroll.sh

blue "starting ordering nodes, peers, state databases and IPFS"
for o in "${ORDERER_ORGS[@]}"; do docker compose up -d "orderer.$o.antidoping.org"; done
docker compose up -d --build cli
docker compose up -d ipfs0 ipfs1 ipfs2
for o in "${ORGS[@]}"; do
  docker compose up -d "peer0.$o.antidoping.org" "peer1.$o.antidoping.org"
done

blue "waiting for the ordering nodes"
for o in "${ORDERER_ORGS[@]}"; do
  for _ in $(seq 1 60); do
    docker compose logs "orderer.$o.antidoping.org" 2>/dev/null | grep -q "Beginning to serve requests" && break
    sleep 2
  done
done

CONSENSUS=$CONSENSUS ./scripts/create-channel.sh
blue "network is up"
docker compose ps --format 'table {{.Name}}\t{{.Status}}' | head -45
