#!/usr/bin/env bash
# Create the antidopingchannel genesis block and join every orderer and peer.
#
# CONSENSUS=raft gives an etcdraft channel; CONSENSUS=bft gives a SmartBFT
# channel. Both use the same four ordering nodes, one per operating
# organisation. Uses the channel participation API (osnadmin); all commands
# execute inside the cli container.
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like absolute Unix paths
# (/work/... becomes C:/Program Files/Git/work/...). Container paths must survive verbatim.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CHANNEL=${CHANNEL:-antidopingchannel}
CONSENSUS=${CONSENSUS:-$(cat network/.consensus 2>/dev/null || echo raft)}
DOMAIN=antidoping.org
ORG_ROOT=/work/network/organizations
case "$CONSENSUS" in
  raft) PROFILE=AntidopingRaft ;;
  bft)  PROFILE=AntidopingBFT ;;
  *) echo "CONSENSUS must be raft or bft" >&2; exit 1 ;;
esac

# org:port-base — peer i listens on <base>051 + 10*i; the orderer on <base>050.
ORG_PORTS=(athlete:7 federation:8 nado:9 lab:10 research:11)
ORDERER_ORGS=(athlete:7 federation:8 nado:9 lab:10)
declare -A MSP=( [athlete]=AthleteMSP [federation]=FederationMSP [nado]=NADOMSP \
                 [lab]=LabMSP [research]=ResearchMSP )

blue() { printf '\033[0;34m[channel]\033[0m %s\n' "$*"; }
incli() { docker compose exec -T cli sh -c "$1"; }

blue "generating $CONSENSUS genesis block for $CHANNEL (profile $PROFILE)"
incli "FABRIC_CFG_PATH=/work/network/configtx configtxgen \
  -profile $PROFILE -outputBlock /work/network/channel-artifacts/$CHANNEL.block \
  -channelID $CHANNEL"

for entry in "${ORDERER_ORGS[@]}"; do
  org=${entry%%:*}; base=${entry##*:}
  tls=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/orderers/orderer.$org.$DOMAIN/tls
  blue "joining orderer.$org.$DOMAIN"
  incli "osnadmin channel join --channelID $CHANNEL \
    --config-block /work/network/channel-artifacts/$CHANNEL.block \
    -o orderer.$org.$DOMAIN:$((base * 1000 + 53)) \
    --ca-file $tls/ca.crt --client-cert $tls/server.crt --client-key $tls/server.key"
done

blue "waiting for the ordering service to elect a leader"
sleep 8

for entry in "${ORG_PORTS[@]}"; do
  org=${entry%%:*}; base=${entry##*:}
  for i in 0 1; do
    port=$((base * 1000 + 51 + 10 * i))
    peer=peer$i.$org.$DOMAIN
    blue "joining $peer"
    for attempt in 1 2 3 4 5; do
      if incli "CORE_PEER_LOCALMSPID=${MSP[$org]} \
        CORE_PEER_MSPCONFIGPATH=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/users/Admin@$org.$DOMAIN/msp \
        CORE_PEER_TLS_ROOTCERT_FILE=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/$peer/tls/ca.crt \
        CORE_PEER_ADDRESS=$peer:$port \
        peer channel join -b /work/network/channel-artifacts/$CHANNEL.block"; then
        break
      fi
      sleep 3
    done
  done
done

blue "channel $CHANNEL created under $CONSENSUS; 4 orderers and 10 peers joined"
incli "CORE_PEER_LOCALMSPID=NADOMSP \
  CORE_PEER_MSPCONFIGPATH=$ORG_ROOT/peerOrganizations/nado.$DOMAIN/users/Admin@nado.$DOMAIN/msp \
  CORE_PEER_TLS_ROOTCERT_FILE=$ORG_ROOT/peerOrganizations/nado.$DOMAIN/peers/peer0.nado.$DOMAIN/tls/ca.crt \
  CORE_PEER_ADDRESS=peer0.nado.$DOMAIN:9051 peer channel list"
