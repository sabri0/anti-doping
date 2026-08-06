#!/usr/bin/env bash
# Create the antidopingchannel genesis block and join all ten peers.
# Uses the Fabric 2.5 channel participation API (osnadmin), not the deprecated
# system channel. All commands execute inside the cli container.
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like absolute Unix paths
# (/work/... becomes C:/Program Files/Git/work/...). Container paths must survive verbatim.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CHANNEL=${CHANNEL:-antidopingchannel}
DOMAIN=antidoping.org
ORG_ROOT=/work/network/organizations
ORDERER_ADMIN_TLS=$ORG_ROOT/ordererOrganizations/$DOMAIN/orderers/orderer.$DOMAIN/tls

# org:port-base — peer i listens on <base>051 + 10*i
ORG_PORTS=(athlete:7 federation:8 nado:9 lab:10 research:11)
declare -A MSP=( [athlete]=AthleteMSP [federation]=FederationMSP [nado]=NADOMSP \
                 [lab]=LabMSP [research]=ResearchMSP )

blue() { printf '\033[0;34m[channel]\033[0m %s\n' "$*"; }
incli() { docker compose exec -T cli sh -c "$1"; }

blue "generating genesis block for $CHANNEL"
incli "FABRIC_CFG_PATH=/work/network/configtx configtxgen \
  -profile AntidopingChannel -outputBlock /work/network/channel-artifacts/$CHANNEL.block \
  -channelID $CHANNEL"

blue "joining the ordering service to $CHANNEL"
incli "osnadmin channel join --channelID $CHANNEL \
  --config-block /work/network/channel-artifacts/$CHANNEL.block \
  -o orderer.$DOMAIN:7053 \
  --ca-file $ORDERER_ADMIN_TLS/ca.crt \
  --client-cert $ORDERER_ADMIN_TLS/server.crt \
  --client-key $ORDERER_ADMIN_TLS/server.key"

sleep 3

for entry in "${ORG_PORTS[@]}"; do
  org=${entry%%:*}; base=${entry##*:}
  for i in 0 1; do
    port=$((base * 1000 + 51 + 10 * i))
    peer=peer$i.$org.$DOMAIN
    blue "joining $peer"
    incli "CORE_PEER_LOCALMSPID=${MSP[$org]} \
      CORE_PEER_MSPCONFIGPATH=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/users/Admin@$org.$DOMAIN/msp \
      CORE_PEER_TLS_ROOTCERT_FILE=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/$peer/tls/ca.crt \
      CORE_PEER_ADDRESS=$peer:$port \
      peer channel join -b /work/network/channel-artifacts/$CHANNEL.block"
  done
done

blue "channel $CHANNEL created; 10 peers joined"
incli "CORE_PEER_LOCALMSPID=NADOMSP \
  CORE_PEER_MSPCONFIGPATH=$ORG_ROOT/peerOrganizations/nado.$DOMAIN/users/Admin@nado.$DOMAIN/msp \
  CORE_PEER_TLS_ROOTCERT_FILE=$ORG_ROOT/peerOrganizations/nado.$DOMAIN/peers/peer0.nado.$DOMAIN/tls/ca.crt \
  CORE_PEER_ADDRESS=peer0.nado.$DOMAIN:9051 peer channel list"
