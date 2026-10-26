#!/usr/bin/env bash
# Deploy the custody chaincode as previously reported (git commit b09c004 /
# 6f6601d, extracted to network/v1-reference) under the name custodyv1, next
# to the current design, so that the insider test can be run against both.
#
# It is deployed exactly as it was then: chaincode-level OR policy, no private
# data collection, cross-organisation endorsement applied only by key-level
# policy on keys that already exist.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CHANNEL=${CHANNEL:-antidopingchannel}
DOMAIN=antidoping.org
PY=${PY:-python}
ORG_ROOT=/work/network/organizations
ORDERER=orderer.nado.$DOMAIN:9050
ORDERER_CA=$ORG_ROOT/peerOrganizations/nado.$DOMAIN/tlsca/tlsca.nado.$DOMAIN-cert.pem
POLICY_OR="OR('AthleteMSP.peer','FederationMSP.peer','NADOMSP.peer','LabMSP.peer','ResearchMSP.peer')"
ORG_PORTS=(athlete:7 federation:8 nado:9 lab:10 research:11)
declare -A MSP=( [athlete]=AthleteMSP [federation]=FederationMSP [nado]=NADOMSP [lab]=LabMSP [research]=ResearchMSP )
NAME=custodyv1
SERVICE=custodyv1-cc
PKGDIR=/work/network/chaincode-packages/$NAME

blue() { printf '\033[0;34m[v1-reference]\033[0m %s\n' "$*"; }
incli() { docker compose exec -T cli sh -c "$1"; }
peer_env() {
  local org=$1 i=$2 base=$3
  echo "CORE_PEER_LOCALMSPID=${MSP[$org]} \
CORE_PEER_MSPCONFIGPATH=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/users/Admin@$org.$DOMAIN/msp \
CORE_PEER_TLS_ROOTCERT_FILE=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/peer$i.$org.$DOMAIN/tls/ca.crt \
CORE_PEER_ADDRESS=peer$i.$org.$DOMAIN:$((base * 1000 + 51 + 10 * i))"
}

[ -d network/v1-reference/chaincode/custody ] || {
  mkdir -p network/v1-reference
  git archive 6f6601d chaincode/custody | tar -x -C network/v1-reference
}

blue "building the previously reported custody chaincode"
docker build -q -t antidoping/custody-cc:1.0-reference network/v1-reference/chaincode/custody >/dev/null

incli "rm -rf $PKGDIR && mkdir -p $PKGDIR && cd $PKGDIR && \
  printf '{\"address\":\"$SERVICE:9999\",\"dial_timeout\":\"10s\",\"tls_required\":false}' > connection.json && \
  tar czf code.tar.gz --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner connection.json && \
  printf '{\"type\":\"ccaas\",\"label\":\"${NAME}_1.0\"}' > metadata.json && \
  tar czf $NAME.tgz --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner metadata.json code.tar.gz"
PKGID=$(incli "peer lifecycle chaincode calculatepackageid $PKGDIR/$NAME.tgz" | tr -d '\r\n')
blue "package id $PKGID"

docker rm -f "$SERVICE" >/dev/null 2>&1 || true
docker run -d --name "$SERVICE" --network antidoping_v2 --cpuset-cpus "${NET_CPUS:-0-5}" \
  -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 -e CHAINCODE_ID="$PKGID" -e CORE_CHAINCODE_ID_NAME="$PKGID" \
  antidoping/custody-cc:1.0-reference >/dev/null

for entry in "${ORG_PORTS[@]}"; do
  org=${entry%%:*} base=${entry##*:}
  for i in 0 1; do
    incli "$(peer_env "$org" "$i" "$base") peer lifecycle chaincode install $PKGDIR/$NAME.tgz" >/dev/null 2>&1 || true
  done
done
ARGS="--channelID $CHANNEL --name $NAME --version 1.0 --sequence 1 --signature-policy \"$POLICY_OR\""
for entry in "${ORG_PORTS[@]}"; do
  org=${entry%%:*} base=${entry##*:}
  incli "$(peer_env "$org" 0 "$base") peer lifecycle chaincode approveformyorg -o $ORDERER --tls --cafile $ORDERER_CA --package-id $PKGID $ARGS" >/dev/null 2>&1
done
PEERS=""
for entry in "${ORG_PORTS[@]}"; do
  org=${entry%%:*} base=${entry##*:}
  PEERS="$PEERS --peerAddresses peer0.$org.$DOMAIN:$((base * 1000 + 51)) --tlsRootCertFiles $ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/peer0.$org.$DOMAIN/tls/ca.crt"
done
incli "$(peer_env nado 0 9) peer lifecycle chaincode commit -o $ORDERER --tls --cafile $ORDERER_CA $ARGS $PEERS" >/dev/null 2>&1
blue "custodyv1 committed"
